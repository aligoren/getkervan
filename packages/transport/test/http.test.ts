import { createApp, silentLogger } from "@kervan/core"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { afterEach, describe, expect, it } from "vitest"
import { type HttpOptions, type HttpServerHandle, serveHttp } from "../src/node.js"
import { demoApp, MODERN, messagesOf, modernRequest, rawRequest } from "./helpers.js"

const handles: HttpServerHandle[] = []
const clients: Client[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
})

async function start(options: HttpOptions = {}, app = demoApp()) {
  const handle = await serveHttp(app, { port: 0, ...options })
  handles.push(handle)
  return handle
}

async function connectClient(url: URL, era: "modern" | "legacy") {
  const client = new Client(
    { name: "http-test", version: "0.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: MODERN } } } : {},
  )
  await client.connect(new StreamableHTTPClientTransport(url))
  clients.push(client)
  return client
}

function send(url: URL, request: ReturnType<typeof modernRequest>) {
  return rawRequest(url, { headers: request.headers, body: request.body })
}

describe("serveHttp with real clients", () => {
  it("binds to localhost on the requested port and path", async () => {
    const { url } = await start({ path: "/custom" })
    expect(url.hostname).toBe("127.0.0.1")
    expect(url.pathname).toBe("/custom")
  })

  it.each(["modern", "legacy"] as const)("lists and calls tools (%s era)", async (era) => {
    const { url } = await start()
    const client = await connectClient(url, era)
    expect(client.getProtocolEra()).toBe(era)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(["zeta", "add", "alpha", "whoami"])
    const result = await client.callTool({ name: "add", arguments: { a: 20, b: 22 } })
    expect(result.structuredContent).toEqual({ sum: 42 })
  })

  it("serves interleaved modern and legacy clients statelessly", async () => {
    const { url } = await start()
    const modern = await connectClient(url, "modern")
    const legacy = await connectClient(url, "legacy")
    for (let i = 0; i < 3; i++) {
      const [m, l] = await Promise.all([
        modern.callTool({ name: "add", arguments: { a: i, b: 1 } }),
        legacy.callTool({ name: "add", arguments: { a: i, b: 2 } }),
      ])
      expect(m.structuredContent).toEqual({ sum: i + 1 })
      expect(l.structuredContent).toEqual({ sum: i + 2 })
    }
  })

  it("keeps tools/list order identical across requests and eras", async () => {
    const { url } = await start()
    const modern = await connectClient(url, "modern")
    const legacy = await connectClient(url, "legacy")
    const lists = await Promise.all([
      modern.listTools(),
      legacy.listTools(),
      modern.listTools(),
      legacy.listTools(),
    ])
    const orders = lists.map(({ tools }) => tools.map((tool) => tool.name).join(","))
    expect(new Set(orders)).toEqual(new Set(["zeta,add,alpha,whoami"]))
  })
})

describe("protocol edge cases", () => {
  it("answers 2025 session operations (GET, DELETE) with 405", async () => {
    const { url } = await start()
    const sessionHeader = { "mcp-session-id": "some-old-session" }
    const get = await rawRequest(url, { method: "GET", headers: sessionHeader })
    const del = await rawRequest(url, { method: "DELETE", headers: sessionHeader })
    expect(get.status).toBe(405)
    expect(del.status).toBe(405)
  })

  it("does not create or echo sessions", async () => {
    const { url } = await start()
    const response = await send(url, modernRequest("tools/list"))
    expect(response.status).toBe(200)
    expect(response.headers["mcp-session-id"]).toBeUndefined()
  })

  it("rejects an unsupported protocol version with 400 / -32022", async () => {
    const { url } = await start()
    const request = modernRequest(
      "tools/list",
      {},
      {
        meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" },
        headers: { "mcp-protocol-version": "2099-01-01" },
      },
    )
    const response = await send(url, request)
    expect(response.status).toBe(400)
    expect(messagesOf(response)[0]).toMatchObject({
      error: { code: -32022, data: { supported: [MODERN] } },
    })
  })

  it("rejects header/body disagreement with 400 / -32020", async () => {
    const { url } = await start()
    const request = modernRequest("tools/list", {}, { headers: { "mcp-method": "tools/call" } })
    const response = await send(url, request)
    expect(response.status).toBe(400)
    expect(messagesOf(response)[0]).toMatchObject({ error: { code: -32020 } })
  })

  it("rejects bodies over the size limit with 413", async () => {
    const { url } = await start({ maxRequestBodySize: 1024 })
    const request = modernRequest("tools/call", {
      name: "alpha",
      arguments: { padding: "x".repeat(4096) },
    })
    const response = await send(url, request)
    expect(response.status).toBe(413)
  })

  it("refuses JSON-RPC batches with rejectBatches, and serves them otherwise", async () => {
    let calls = 0
    const app = createApp({ name: "batch", version: "0.0.0", logger: silentLogger })
    app.tool("count", {
      description: "Counts calls",
      handler: () => {
        calls++
        return String(calls)
      },
    })
    const batch = Array.from({ length: 5 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "tools/call",
      params: { name: "count", arguments: {} },
    }))
    const headers = { "mcp-protocol-version": "2025-03-26" }

    const strict = await start({ rejectBatches: true }, app)
    const refused = await rawRequest(strict.url, { headers, body: batch })
    expect(refused.status).toBe(400)
    expect(messagesOf(refused)[0]).toMatchObject({ error: { code: -32600 } })
    expect(calls).toBe(0)

    const lenient = await start({}, app)
    await rawRequest(lenient.url, { headers, body: batch })
    expect(calls).toBe(5)
  })

  it("returns 404 outside the MCP path", async () => {
    const { url } = await start()
    const response = await rawRequest(new URL("/elsewhere", url), { body: {} })
    expect(response.status).toBe(404)
  })
})

describe("Host and Origin validation", () => {
  it("rejects a foreign Host header with 403 (DNS rebinding)", async () => {
    const { url } = await start()
    const request = modernRequest("tools/list")
    const response = await rawRequest(url, {
      headers: { ...request.headers, host: "evil.example" },
      body: request.body,
    })
    expect(response.status).toBe(403)
  })

  it("rejects a foreign Origin header with 403", async () => {
    const { url } = await start()
    const request = modernRequest("tools/list")
    const response = await rawRequest(url, {
      headers: { ...request.headers, origin: "https://evil.example" },
      body: request.body,
    })
    expect(response.status).toBe(403)
  })

  it("accepts a localhost Origin", async () => {
    const { url } = await start()
    const request = modernRequest("tools/list")
    const response = await rawRequest(url, {
      headers: { ...request.headers, origin: "http://localhost:5173" },
      body: request.body,
    })
    expect(response.status).toBe(200)
  })

  it("accepts configured hosts", async () => {
    const { url } = await start({ allowedHosts: ["mcp.example.com"] })
    const request = modernRequest("tools/list")
    const response = await rawRequest(url, {
      headers: { ...request.headers, host: "mcp.example.com" },
      body: request.body,
    })
    expect(response.status).toBe(200)
  })
})

describe("rate limiting", () => {
  it("answers 429 with Retry-After once the limit is reached", async () => {
    const { url } = await start({ rateLimit: { max: 3, windowMs: 60_000 } })
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) statuses.push((await send(url, modernRequest("tools/list"))).status)
    expect(statuses).toEqual([200, 200, 200, 429])
    const limited = await send(url, modernRequest("tools/list"))
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0)
  })

  it("does not trust X-Forwarded-For by default", async () => {
    const { url } = await start({ rateLimit: { max: 2, windowMs: 60_000 } })
    const statuses: number[] = []
    for (let i = 0; i < 4; i++) {
      const request = modernRequest(
        "tools/list",
        {},
        { headers: { "x-forwarded-for": `10.0.0.${i}` } },
      )
      statuses.push((await send(url, request)).status)
    }
    expect(statuses).toEqual([200, 200, 429, 429])
  })

  it("uses a custom keyGenerator", async () => {
    const { url } = await start({
      rateLimit: { max: 1, windowMs: 60_000, keyGenerator: (c) => c.req.header("x-api-key") ?? "" },
    })
    const withKey = (key: string) =>
      send(url, modernRequest("tools/list", {}, { headers: { "x-api-key": key } }))
    expect((await withKey("a")).status).toBe(200)
    expect((await withKey("b")).status).toBe(200)
    expect((await withKey("a")).status).toBe(429)
  })

  it("can be disabled", async () => {
    const { url } = await start({ rateLimit: false })
    for (let i = 0; i < 5; i++) {
      expect((await send(url, modernRequest("tools/list"))).status).toBe(200)
    }
  })
})

describe("tools/list cache hints", () => {
  it("defaults to ttlMs 0 and private scope", async () => {
    const { url } = await start()
    const [message] = messagesOf(await send(url, modernRequest("tools/list")))
    expect(message?.result).toMatchObject({ ttlMs: 0, cacheScope: "private" })
  })

  it("passes listCache through", async () => {
    const app = createApp({
      name: "cached",
      version: "0.0.0",
      logger: silentLogger,
      listCache: { ttlMs: 60_000, cacheScope: "public" },
    })
    app.tool("t", { description: "t", handler: () => "t" })
    const { url } = await start({}, app)
    const [message] = messagesOf(await send(url, modernRequest("tools/list")))
    expect(message?.result).toMatchObject({ ttlMs: 60_000, cacheScope: "public" })
  })
})

describe("protocol logging", () => {
  const callAdd = (logLevel?: string) =>
    modernRequest(
      "tools/call",
      { name: "add", arguments: { a: 1, b: 2 } },
      logLevel === undefined ? {} : { meta: { "io.modelcontextprotocol/logLevel": logLevel } },
    )
  const logMessages = (messages: Record<string, unknown>[]) =>
    messages.filter((message) => message.method === "notifications/message")

  it("forwards ctx.log when enabled and the request carries a logLevel", async () => {
    const { url } = await start({}, demoApp({ protocolLogging: true }))
    const messages = messagesOf(await send(url, callAdd("debug")))
    expect(logMessages(messages)).toEqual([
      {
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level: "info", logger: "add", data: { message: "adding", data: { a: 1, b: 2 } } },
      },
    ])
  })

  it("does not forward without a logLevel in _meta", async () => {
    const { url } = await start({}, demoApp({ protocolLogging: true }))
    const messages = messagesOf(await send(url, callAdd()))
    expect(logMessages(messages)).toEqual([])
    expect(messages.at(-1)?.result).toMatchObject({ structuredContent: { sum: 3 } })
  })

  it("does not forward or advertise logging when protocolLogging is off", async () => {
    const { url } = await start()
    expect(logMessages(messagesOf(await send(url, callAdd("debug"))))).toEqual([])
    const [discover] = messagesOf(await send(url, modernRequest("server/discover")))
    expect(discover?.result).toMatchObject({ capabilities: { tools: { listChanged: true } } })
    const result = discover?.result as { capabilities: object } | undefined
    expect(result?.capabilities).not.toHaveProperty("logging")
  })
})

describe("authenticate hook", () => {
  const options: HttpOptions = {
    authenticate: (request) => {
      const header = request.headers.get("authorization")
      if (header !== "Bearer good-token") {
        return new Response(null, {
          status: 401,
          headers: { "www-authenticate": 'Bearer error="invalid_token"' },
        })
      }
      return { token: "good-token", clientId: "client-7", scopes: ["tools"] }
    },
  }

  it("rejects with the hook's response", async () => {
    const { url } = await start(options)
    const response = await send(url, modernRequest("tools/list"))
    expect(response.status).toBe(401)
    expect(response.headers["www-authenticate"]).toContain("invalid_token")
  })

  it("hands accepted auth info to tools", async () => {
    const { url } = await start(options)
    const request = modernRequest(
      "tools/call",
      { name: "whoami", arguments: {} },
      { headers: { authorization: "Bearer good-token" } },
    )
    const [message] = messagesOf(await send(url, request))
    expect(message?.result).toMatchObject({ content: [{ type: "text", text: "client-7" }] })
  })
})
