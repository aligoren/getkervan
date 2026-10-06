import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { NetworkPolicy } from "@kervan/spec-runtime"
import { LoginThrottle, type ThrottleOptions } from "../src/api/throttle.js"
import { hashPassword } from "../src/crypto.js"
import { openDatabase } from "../src/db/open.js"
import { issueSetupToken } from "../src/db/repos/tokens.js"
import { createUser, type Role } from "../src/db/repos/users.js"
import { defaultWorkspace } from "../src/db/repos/workspaces.js"
import { createStudioHttp } from "../src/http.js"
import { staticKeyProvider } from "../src/keys.js"
import { Studio } from "../src/studio.js"
import { DbSecretStore } from "../src/vault.js"
import { recordingLogger, TEST_ONLY_NETWORK } from "./helpers.js"

export const ORIGIN = "https://studio.test"
/** A fixed master key for tests only. */
export const TEST_KEYS = staticKeyProvider({ version: 1, key: Buffer.alloc(32, 9) })
export const PASSWORD = "correct horse battery staple"

/** A Studio HTTP app driven through `fetch` (no socket), as it runs behind TLS at ORIGIN. */
export function apiStudio(options: { throttle?: ThrottleOptions; network?: NetworkPolicy } = {}) {
  const database = openDatabase(":memory:")
  const logger = recordingLogger()
  const secrets = new DbSecretStore(database.db, TEST_KEYS)
  const studio = new Studio({
    db: database.db,
    secrets,
    network: options.network ?? TEST_ONLY_NETWORK,
    allowedHosts: ["studio.test"],
    logger,
    allowSecretsOverHttp: true,
  })
  // The web root sits next to a file it must never serve (path traversal tests).
  const webBase = mkdtempSync(path.join(os.tmpdir(), "kervan-web-"))
  const webRoot = path.join(webBase, "root")
  mkdirSync(path.join(webRoot, "assets"), { recursive: true })
  writeFileSync(path.join(webBase, "secret.txt"), "TOP-SECRET-OUTSIDE-WEB-ROOT")
  writeFileSync(path.join(webRoot, "index.html"), "<!doctype html><title>Kervan Studio</title>")
  writeFileSync(path.join(webRoot, "assets", "app-1234.js"), "console.log('app')")
  let adminCreated = 0
  const http = createStudioHttp(
    studio,
    { publicUrl: new URL(ORIGIN), trustProxy: 1 },
    {
      throttle: new LoginThrottle(options.throttle),
      webRoot,
      onAdminCreated: () => {
        adminCreated++
      },
    },
  )
  const scope = defaultWorkspace(database.db)

  /**
   * Sends a request as a browser on ORIGIN would: same-origin headers and the session cookie,
   * unless overridden. `ip` becomes the client address (one trusted proxy).
   */
  const request = async (
    method: string,
    pathname: string,
    init: {
      body?: unknown
      cookie?: string
      csrf?: string
      headers?: Record<string, string | undefined>
      ip?: string
    } = {},
  ) => {
    const headers: Record<string, string> = {
      host: "studio.test",
      "x-forwarded-for": init.ip ?? "203.0.113.1",
    }
    if (method !== "GET") {
      headers.origin = ORIGIN
      headers["sec-fetch-site"] = "same-origin"
      headers["content-type"] = "application/json"
    }
    if (init.cookie) headers.cookie = init.cookie
    if (init.csrf) headers["x-csrf-token"] = init.csrf
    for (const [name, value] of Object.entries(init.headers ?? {})) {
      if (value === undefined) delete headers[name]
      else headers[name] = value
    }
    const response = await http.fetch(
      new Request(`${ORIGIN}${pathname}`, {
        method,
        headers,
        ...(init.body === undefined
          ? {}
          : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
      }),
    )
    const text = await response.text()
    let json: Record<string, unknown> = {}
    try {
      json = JSON.parse(text) as Record<string, unknown>
    } catch {
      // Not JSON (export, web files).
    }
    return { status: response.status, headers: response.headers, text, json }
  }

  /** Signs in and returns what a browser keeps: the cookie and the CSRF token. */
  const signIn = async (email: string, password = PASSWORD, ip?: string) => {
    const response = await request("POST", "/api/login", {
      body: { email, password },
      ...(ip ? { ip } : {}),
    })
    if (response.status !== 200)
      throw new Error(`login failed: ${response.status} ${response.text}`)
    return { cookie: cookieOf(response.headers), csrf: String(response.json.csrfToken) }
  }

  const addUser = async (email: string, role: Role) => {
    const passwordHash = await hashPassword(PASSWORD)
    return createUser(database.db, scope, { email, passwordHash, role })
  }

  return {
    studio,
    database,
    secrets,
    logger,
    scope,
    request,
    signIn,
    addUser,
    setupToken: () => issueSetupToken(database.db).token,
    adminCreated: () => adminCreated,
    close: async () => {
      await studio.close()
      database.close()
      rmSync(webBase, { recursive: true, force: true })
    },
  }
}

/** The `name=value` part of the session cookie a response sets. */
export function cookieOf(headers: Headers): string {
  const header = headers.get("set-cookie") ?? ""
  return header.split(";")[0] ?? ""
}

export type ApiStudio = ReturnType<typeof apiStudio>

/** A real MCP client on the gateway, through Studio's whole HTTP app, as a same-origin caller. */
export async function gatewayClient(
  s: ApiStudio,
  serverId: string,
  bearer: string,
  cleanups: (() => Promise<void>)[],
) {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client")
  const transport = new StreamableHTTPClientTransport(new URL(`/s/${serverId}/mcp`, ORIGIN), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
    fetch: async (url, init) => {
      const request = new Request(url, init)
      const headers: Record<string, string> = {}
      request.headers.forEach((value, name) => {
        headers[name] = value
      })
      headers.host = "studio.test"
      headers.origin = ORIGIN
      const body = request.method === "GET" ? undefined : await request.text()
      const response = await s.request(request.method, new URL(request.url).pathname, {
        headers,
        ...(body ? { body } : {}),
      })
      return new Response(response.text, { status: response.status, headers: response.headers })
    },
  })
  const client = new Client(
    { name: "gateway-test", version: "0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  )
  await client.connect(transport)
  cleanups.push(() => client.close())
  return client
}
