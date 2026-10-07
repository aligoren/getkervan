// Host and Origin checks end to end, with Studio configured as `kervan-studio start` configures
// it, over real HTTP. A DNS rebinding page (an attacker's name that resolves to 127.0.0.1) reaches
// the socket but names its own host; a browser page on another origin sends its Origin. MCP
// clients outside a browser send no Origin and only need a valid key.
//
// Three layers: `createStudioHttp` checks `Host` on every path; the gateway compares `Origin` with
// Studio's exact origin; the SDK checks host names again inside the gateway.
import { request as httpRequest } from "node:http"
import type { AddressInfo } from "node:net"
import { serve } from "@hono/node-server"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { allowedHostNames } from "../src/config.js"
import { openDatabase } from "../src/db/open.js"
import { createWorkspace } from "../src/db/repos/workspaces.js"
import { createStudioHttp } from "../src/http.js"
import { InMemorySecretStore } from "../src/secrets.js"
import { Studio } from "../src/studio.js"
import {
  echoTool,
  MODERN,
  recordingLogger,
  spec,
  startUpstream,
  TEST_ONLY_NETWORK,
  type Upstream,
  user,
} from "./helpers.js"

let upstream: Upstream
beforeAll(async () => {
  upstream = await startUpstream()
})
afterAll(() => upstream.close())

const closers: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

/** Studio wired like `server.ts` does, with one published server and a key for it. */
async function studioAt(publicUrl: string) {
  const config = { publicUrl: new URL(publicUrl), trustProxy: 0 }
  const database = openDatabase(":memory:")
  const studio = new Studio({
    db: database.db,
    secrets: new InMemorySecretStore(),
    network: TEST_ONLY_NETWORK,
    allowedHosts: allowedHostNames(config),
    allowedOrigins: [config.publicUrl.origin],
    logger: recordingLogger(),
    allowSecretsOverHttp: true,
  })
  const http = createStudioHttp(studio, config)
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const listening = serve({ fetch: http.fetch, port: 0, hostname: "127.0.0.1" }, () =>
      resolve(listening),
    )
  })
  closers.push(async () => {
    await studio.close()
    await new Promise<void>((done) => {
      server.close(() => done())
      if ("closeAllConnections" in server) server.closeAllConnections()
    })
    database.close()
  })
  const scope = createWorkspace(database.db, "w")
  const created = studio.createServer(scope, { slug: "s", name: "S" }, user())
  const version = studio.saveVersion(
    scope,
    created.id,
    spec(echoTool(`http://api.test:${upstream.port}/echo/a`)),
    user(),
  )
  await studio.publish(scope, created.id, version.id, user())
  const { key } = studio.createApiKey(scope, created.id, "k", user())
  return {
    studio,
    port: (server.address() as AddressInfo).port,
    path: `/s/${created.id}/mcp`,
    key,
    host: config.publicUrl.host,
    origin: config.publicUrl.origin,
  }
}

const TOOLS_LIST = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
})

/** A raw request to 127.0.0.1 with exactly these headers (including `Host`). */
function send(
  port: number,
  options: { path: string; method?: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: options.path,
        method: options.method ?? "GET",
        setHost: false,
        headers: options.headers,
      },
      (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => {
          body += chunk
        })
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
    req.on("error", reject)
    req.end(options.body)
  })
}

/** tools/list on the gateway with a valid key, plus the given `Host` and `Origin`. */
function toolsList(
  s: Awaited<ReturnType<typeof studioAt>>,
  host: string,
  origin?: string,
  key = s.key,
) {
  return send(s.port, {
    path: s.path,
    method: "POST",
    headers: {
      host,
      ...(origin === undefined ? {} : { origin }),
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/list",
    },
    body: TOOLS_LIST,
  })
}

describe.each([
  ["a public deployment", "https://studio.example.test"],
  ["a local Studio", "http://127.0.0.1:4310"],
])("Host and Origin on %s", (_name, publicUrl) => {
  it("serves an MCP client without Origin, and the browser on Studio's own origin", async () => {
    const s = await studioAt(publicUrl)
    const noOrigin = await toolsList(s, s.host)
    expect(noOrigin.status).toBe(200)
    expect(noOrigin.body).toContain('"echo"')
    const ownOrigin = await toolsList(s, s.host, s.origin)
    expect(ownOrigin.status).toBe(200)
    expect(ownOrigin.body).toContain('"echo"')
  })

  it("refuses a DNS rebinding request on every path, even with a valid key", async () => {
    const s = await studioAt(publicUrl)
    const rebound = `rebind.attacker.test:${s.port}`
    const origin = `http://rebind.attacker.test:${s.port}`
    expect((await toolsList(s, rebound, origin)).status).toBe(403)
    expect((await toolsList(s, rebound)).status).toBe(403)
    for (const [method, path] of [
      ["GET", "/api/session"],
      ["GET", "/api/me"],
      ["POST", "/api/setup"],
      ["POST", "/api/login"],
      ["GET", "/"],
    ] as const) {
      const response = await send(s.port, {
        path,
        method,
        headers: { host: rebound, origin, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      })
      expect(response.status, `${method} ${path}`).toBe(403)
      expect(response.body, `${method} ${path}`).toContain("Unknown host")
    }
  })

  it("refuses every other Origin on the gateway, even with a valid key", async () => {
    const s = await studioAt(publicUrl)
    const own = new URL(s.origin)
    const otherScheme = `${own.protocol === "https:" ? "http:" : "https:"}//${own.host}`
    const otherPort = `${own.protocol}//${own.hostname}:8443`
    for (const origin of [
      otherScheme,
      otherPort,
      "https://attacker.test",
      `${own.protocol}//${own.hostname}.attacker.test`,
      "null",
      "not a url",
    ]) {
      const response = await toolsList(s, s.host, origin)
      expect(response.status, origin).toBe(403)
      expect(response.body, origin).not.toContain('"echo"')
    }
  })

  it("still needs the key when Host and Origin are right", async () => {
    const s = await studioAt(publicUrl)
    expect((await toolsList(s, s.host, s.origin, "kvn_wrong")).status).toBe(401)
    expect((await toolsList(s, s.host, undefined, "kvn_wrong")).status).toBe(401)
  })
})

describe("the gateway's own checks, without Studio's HTTP layer", () => {
  it("refuses another Host and another Origin by itself", async () => {
    const s = await studioAt("https://studio.example.test")
    const call = (headers: Record<string, string>) =>
      s.studio.gateway.fetch(
        new Request(`https://studio.example.test${s.path}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${s.key}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": MODERN,
            "mcp-method": "tools/list",
            ...headers,
          },
          body: TOOLS_LIST,
        }),
      )
    expect((await call({ host: "studio.example.test" })).status).toBe(200)
    expect((await call({ host: "rebind.attacker.test" })).status).toBe(403)
    expect(
      (await call({ host: "studio.example.test", origin: "http://studio.example.test" })).status,
    ).toBe(403)
    expect(
      (await call({ host: "studio.example.test", origin: "https://attacker.test" })).status,
    ).toBe(403)
  })

  it("keeps the SDK's host-name layer behind the exact Origin check", async () => {
    const s = await studioAt("https://studio.example.test")
    // `handler` is what `gateway.fetch` calls after its exact Origin check.
    const call = (origin: string) =>
      s.studio.gateway.handler.fetch(
        new Request(`https://studio.example.test${s.path}`, {
          method: "POST",
          headers: {
            host: "studio.example.test",
            origin,
            authorization: `Bearer ${s.key}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": MODERN,
            "mcp-method": "tools/list",
          },
          body: TOOLS_LIST,
        }),
      )
    expect((await call("https://studio.example.test")).status).toBe(200)
    expect((await call("https://attacker.test")).status).toBe(403)
    expect((await call("https://localhost")).status).toBe(403)
  })
})
