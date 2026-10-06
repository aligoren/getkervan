import {
  type AuthInfo,
  createApp,
  FORBIDDEN,
  InMemoryToolRegistry,
  type ServerResolver,
  silentLogger,
  type ToolRegistry,
} from "@kervan/core"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { afterEach, describe, expect, it } from "vitest"
import type { Authenticate } from "../src/index.js"
import { type HttpServerHandle, serveHttp } from "../src/node.js"
import { MODERN, modernRequest, rawRequest } from "./helpers.js"

// Tokens are the only trusted input; the tenant comes from the verified auth info.
const TOKENS: Record<string, AuthInfo> = {
  "token-a": { token: "token-a", clientId: "alice", scopes: [], extra: { tenant: "acme" } },
  "token-b": { token: "token-b", clientId: "bob", scopes: [], extra: { tenant: "globex" } },
  "token-banned": {
    token: "token-banned",
    clientId: "eve",
    scopes: [],
    extra: { tenant: "banned" },
  },
  "token-ghost": { token: "token-ghost", clientId: "gus", scopes: [], extra: { tenant: "ghost" } },
}

const authenticate: Authenticate = (request) => {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "")
  const info = token ? TOKENS[token] : undefined
  return info ?? new Response(null, { status: 401 })
}

const handles: HttpServerHandle[] = []
const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const def = (text: string) => ({ description: text, handler: () => text })

function setup(options: { resolveServer?: ServerResolver } = {}) {
  const app = createApp({ name: "tenants", version: "0.0.0", logger: silentLogger })
  const acme = new InMemoryToolRegistry()
  acme.add("acme_report", def("acme report"))
  const globex = new InMemoryToolRegistry()
  globex.add("globex_secret_plan", def("globex secret"))
  const tenants: Record<string, ToolRegistry> = { acme, globex }
  const calls: (string | undefined)[] = []

  const resolveServer: ServerResolver =
    options.resolveServer ??
    ((_request, { auth }) => {
      const tenant = auth?.extra?.tenant as string | undefined
      calls.push(tenant)
      if (tenant === "banned") return FORBIDDEN
      return tenant ? tenants[tenant] : undefined
    })
  return { app, acme, globex, calls, resolveServer }
}

async function start(s: ReturnType<typeof setup>) {
  const handle = await serveHttp(s.app, {
    port: 0,
    rateLimit: false,
    authenticate,
    resolveServer: s.resolveServer,
  })
  handles.push(handle)
  return handle
}

async function connect(url: URL, token: string, era: "modern" | "legacy" = "modern") {
  const client = new Client(
    { name: "tenant-test", version: "0.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: MODERN } } } : {},
  )
  await client.connect(
    new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  clients.push(client)
  return client
}

function post(url: URL, token: string | undefined, extraHeaders: Record<string, string> = {}) {
  const request = modernRequest("tools/list")
  return rawRequest(url, {
    headers: {
      ...request.headers,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extraHeaders,
    },
    body: request.body,
  })
}

describe("resolveServer", () => {
  it.each(["modern", "legacy"] as const)(
    "serves each tenant only its own tools (%s)",
    async (era) => {
      const s = setup()
      const { url } = await start(s)
      const a = await connect(url, "token-a", era)
      const b = await connect(url, "token-b", era)
      expect((await a.listTools()).tools.map((t) => t.name)).toEqual(["acme_report"])
      expect((await b.listTools()).tools.map((t) => t.name)).toEqual(["globex_secret_plan"])
    },
  )

  it("does not let one tenant call another tenant's tool", async () => {
    const { url } = await start(setup())
    const a = await connect(url, "token-a")
    const failure = await a
      .callTool({ name: "globex_secret_plan", arguments: {} })
      .then((result) => JSON.stringify(result))
      .catch((error: unknown) => String(error))
    expect(failure).not.toContain("globex secret")
    expect(failure).not.toContain("globex,")
    expect(failure).not.toMatch(/acme_report|tenant/i)
    expect(failure).toMatch(/not found|unknown/i)
  })

  it("does not deliver one tenant's list_changed to another tenant", async () => {
    const s = setup()
    const { url } = await start(s)
    const a = await connect(url, "token-a")
    let aNotified = 0
    a.setNotificationHandler("notifications/tools/list_changed", () => {
      aNotified++
    })
    await a.listen({ toolsListChanged: true })

    s.globex.add("globex_new", def("new"))
    await sleep(80)
    expect(aNotified).toBe(0)

    s.acme.add("acme_new", def("new"))
    await expect.poll(() => aNotified).toBe(1)
    expect((await a.listTools()).tools.map((t) => t.name)).toEqual(["acme_report", "acme_new"])
  })

  it("answers unknown tenants 404 and denied tenants 403 with fixed bodies", async () => {
    const { url } = await start(setup())
    const ghost = await post(url, "token-ghost", { "x-tenant": "ghost-corp" })
    const banned = await post(url, "token-banned", { "x-tenant": "banned-corp" })
    expect(ghost.status).toBe(404)
    expect(JSON.parse(ghost.body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Not found" },
      id: null,
    })
    expect(banned.status).toBe(403)
    expect(JSON.parse(banned.body)).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Forbidden" },
      id: null,
    })
    for (const body of [ghost.body, banned.body]) expect(body).not.toMatch(/ghost|banned|corp/i)
  })

  it("maps resolver failures to a referenced 500 without leaking the error", async () => {
    const s = setup({
      resolveServer: () => {
        throw new Error("tenant db at postgres://admin:hunter2@db/tenants is down")
      },
    })
    const { url } = await start(s)
    const response = await post(url, "token-a")
    expect(response.status).toBe(500)
    expect(response.body).toMatch(/Internal error \(ref: [0-9a-f]{8}\)/)
    expect(response.body).not.toMatch(/hunter2|postgres|tenant/)
  })

  it("runs after authenticate and receives the verified auth info", async () => {
    const s = setup()
    const { url } = await start(s)
    expect((await post(url, undefined)).status).toBe(401)
    expect((await post(url, "wrong-token")).status).toBe(401)
    expect(s.calls).toEqual([])
    expect((await post(url, "token-b")).status).toBe(200)
    expect(s.calls).toEqual(["globex"])
  })

  it("creates one handler per registry and reuses it", async () => {
    const subscribers = new Map<string, number>()
    const counted = (name: string, inner: InMemoryToolRegistry): ToolRegistry => ({
      list: () => inner.list(),
      onChange: (listener) => {
        subscribers.set(name, (subscribers.get(name) ?? 0) + 1)
        return inner.onChange(listener)
      },
    })
    const base = setup()
    const registries = { acme: counted("acme", base.acme), globex: counted("globex", base.globex) }
    const s = setup({
      resolveServer: (_request, { auth }) =>
        registries[auth?.extra?.tenant as keyof typeof registries],
    })
    const handle = await start(s)
    for (let i = 0; i < 3; i++) {
      expect((await post(handle.url, "token-a")).status).toBe(200)
      expect((await post(handle.url, "token-b")).status).toBe(200)
    }
    expect(Object.fromEntries(subscribers)).toEqual({ acme: 1, globex: 1 })
    expect(handle.handler.handlerFor(registries.acme)).toBe(
      handle.handler.handlerFor(registries.acme),
    )
    expect(handle.handler.handlerFor(registries.acme)).not.toBe(
      handle.handler.handlerFor(registries.globex),
    )
  })
})
