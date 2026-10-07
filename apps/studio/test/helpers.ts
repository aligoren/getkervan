import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { serve } from "@hono/node-server"
import type { Logger } from "@kervan/core"
import type { NetworkPolicy } from "@kervan/spec-runtime"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { type OpenedDatabase, openDatabase } from "../src/db/open.js"
import { createApiKey } from "../src/db/repos/api-keys.js"
import { createWorkspace } from "../src/db/repos/workspaces.js"
import type { WorkspaceScope } from "../src/db/scope.js"
import { createStudioHttp } from "../src/http.js"
import { InMemorySecretStore } from "../src/secrets.js"
import { Studio } from "../src/studio.js"

export const MODERN = "2026-07-28"

/** A local API that echoes what it received. */
export interface Upstream {
  url: string
  port: number
  requests: { method: string; path: string; headers: IncomingMessage["headers"] }[]
  close(): Promise<void>
}

export async function startUpstream(): Promise<Upstream> {
  const requests: Upstream["requests"] = []
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://upstream")
    requests.push({ method: req.method ?? "", path: url.pathname, headers: req.headers })
    if (url.pathname.startsWith("/redirect")) {
      res.writeHead(302, { location: url.searchParams.get("to") ?? "/" })
      res.end()
      return
    }
    const status = url.pathname.startsWith("/fail") ? 500 : 200
    res.writeHead(status, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        key: req.headers["x-key"] ?? null,
        note: "<img src=x onerror=alert(1)>",
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise((resolve) => {
        if ("closeAllConnections" in server) server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/**
 * The network policy gateway tests use to reach the local upstream. Production Studio never
 * builds one like it: `studioNetworkPolicy` has no way to allow private addresses.
 */
export const TEST_ONLY_NETWORK: NetworkPolicy = {
  allowPrivate: ["127.0.0.1/32"],
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
}

export function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  const record = (level: string) => (message: string, data?: unknown) => {
    lines.push(`${level} ${message}${data === undefined ? "" : ` ${String(data)}`}`)
  }
  return {
    lines,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  }
}

export interface TestStudio {
  studio: Studio
  database: OpenedDatabase
  secrets: InMemorySecretStore
  logger: Logger & { lines: string[] }
  /** Base URL of the HTTP server (gateway at /s/{id}/mcp). */
  url: URL
  close(): Promise<void>
}

export async function startTestStudio(
  options: {
    network?: NetworkPolicy
    keyRateLimit?: number
    ipRateLimit?: number
    /** The local test API speaks http; production Studio never allows secrets over http. */
    allowSecretsOverHttp?: boolean
  } = {},
): Promise<TestStudio> {
  const database = openDatabase(":memory:")
  const secrets = new InMemorySecretStore()
  const logger = recordingLogger()
  const studio = new Studio({
    db: database.db,
    secrets,
    network: options.network ?? TEST_ONLY_NETWORK,
    allowedHosts: ["127.0.0.1", "localhost"],
    // Clients in these tests are not browsers: they send no Origin.
    allowedOrigins: [],
    logger,
    allowSecretsOverHttp: options.allowSecretsOverHttp ?? true,
    ...(options.keyRateLimit === undefined ? {} : { keyRateLimit: options.keyRateLimit }),
  })
  const http = createStudioHttp(
    studio,
    { publicUrl: new URL("http://127.0.0.1"), trustProxy: 0 },
    options.ipRateLimit === undefined ? {} : { ipRateLimit: options.ipRateLimit },
  )
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const listening = serve({ fetch: http.fetch, port: 0, hostname: "127.0.0.1" }, () =>
      resolve(listening),
    )
  })
  const { port } = server.address() as AddressInfo
  return {
    studio,
    database,
    secrets,
    logger,
    url: new URL(`http://127.0.0.1:${port}`),
    close: async () => {
      await studio.close()
      await new Promise<void>((done) => {
        server.close(() => done())
        if ("closeAllConnections" in server) server.closeAllConnections()
      })
      database.close()
    },
  }
}

export const user = (id = "user-1") => ({ type: "user" as const, id })

/** A workspace with one published server and an API key for it. */
export async function publishedServer(
  t: TestStudio,
  yamlText: string,
  options: { scope?: WorkspaceScope; slug?: string } = {},
) {
  const scope = options.scope ?? createWorkspace(t.database.db, "test")
  const server = t.studio.createServer(
    scope,
    { slug: options.slug ?? "weather", name: "Weather" },
    user(),
  )
  const version = t.studio.saveVersion(scope, server.id, yamlText, user())
  await t.studio.publish(scope, server.id, version.id, user())
  const { key } = t.studio.createApiKey(scope, server.id, "test", user())
  return { scope, server, version, key, mcpUrl: new URL(`/s/${server.id}/mcp`, t.url) }
}

export function unpublishedKey(t: TestStudio, scope: WorkspaceScope, serverId: string): string {
  const created = createApiKey(t.database.db, scope, { serverId, name: "k", createdBy: null })
  if (!created) throw new Error("no such server")
  return created.key
}

export async function connect(
  url: URL,
  key: string,
  era: "modern" | "legacy" = "modern",
): Promise<Client> {
  const client = new Client(
    { name: "studio-test", version: "0.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: MODERN } } } : {},
  )
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${key}` } },
    }),
  )
  return client
}

/** A raw MCP POST (tools/list), for checking status codes. */
export function postToolsList(url: URL, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/list",
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  })
}

export const resultText = (result: unknown) =>
  (result as { content: { text?: string }[] }).content.map((block) => block.text ?? "").join("")

export const spec = (tools: string, head = "") => `specVersion: 1
name: weather
version: 1.0.0
description: Weather tools
${head}
defaults: { http: { allowInsecureHttp: true, timeoutMs: 2000 } }
tools:
${tools}`

export const echoTool = (url: string, name = "echo", extra = "") => `
  - name: ${name}
    description: Echoes
    http:
      url: ${url}
${extra}
    output: { select: "@" }`
