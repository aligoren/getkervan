import {
  createApp,
  InMemoryToolRegistry,
  silentLogger,
  type ToolCall,
  type ToolMiddleware,
} from "@kervan/core"
import type { Client } from "@modelcontextprotocol/client"
import { afterEach, describe, expect, it } from "vitest"
import { type HttpServerHandle, serveHttp } from "../src/node.js"
import { createTestClient } from "../src/testing.js"
import { modernRequest, rawRequest } from "./helpers.js"

const clients: Client[] = []
const handles: HttpServerHandle[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
})

const newApp = () => createApp({ name: "mw", version: "0.0.0", logger: silentLogger })
const record =
  (log: string[]): ToolMiddleware =>
  (call: ToolCall, next) => {
    log.push(call.tool.name)
    return next()
  }

describe.each(["modern", "legacy"] as const)("middleware (%s era)", (era) => {
  it("wraps calls and short-circuits the same way in both eras", async () => {
    const app = newApp()
    const log: string[] = []
    app.use(record(log))
    app.use((call, next) =>
      call.tool.name === "blocked"
        ? { content: [{ type: "text", text: "blocked" }], isError: true }
        : next(),
    )
    app.tool("open", { description: "d", handler: () => "open" })
    app.tool("blocked", { description: "d", handler: () => "should not run" })
    const client = await createTestClient(app, { era })
    clients.push(client)
    expect((await client.callTool({ name: "open", arguments: {} })).content).toEqual([
      { type: "text", text: "open" },
    ])
    expect(await client.callTool({ name: "blocked", arguments: {} })).toMatchObject({
      isError: true,
      content: [{ text: "blocked" }],
    })
    expect(log).toEqual(["open", "blocked"])
  })

  it("applies app.use added at runtime to an already connected client", async () => {
    const app = newApp().tool("t", { description: "d", handler: () => "plain" })
    const client = await createTestClient(app, { era })
    clients.push(client)
    expect((await client.callTool({ name: "t", arguments: {} })).content).toEqual([
      { type: "text", text: "plain" },
    ])
    app.use(async (_call, next) => {
      const result = await next()
      return { ...result, content: [{ type: "text", text: "wrapped" }] }
    })
    expect((await client.callTool({ name: "t", arguments: {} })).content).toEqual([
      { type: "text", text: "wrapped" },
    ])
  })

  it("applies to tools from a registry other than the app's", async () => {
    const app = newApp()
    const log: string[] = []
    app.use(record(log))
    const tenant = new InMemoryToolRegistry()
    tenant.add("tenant_tool", { description: "d", handler: () => "tenant" })
    const client = await createTestClient(app, { era, registry: tenant })
    clients.push(client)
    await client.callTool({ name: "tenant_tool", arguments: {} })
    expect(log).toEqual(["tenant_tool"])
  })
})

describe("middleware with resolveServer over HTTP", () => {
  it("runs for tools served from a resolved tenant registry", async () => {
    const app = newApp()
    const log: string[] = []
    app.use(record(log))
    const tenant = new InMemoryToolRegistry()
    tenant.add("tenant_tool", { description: "d", handler: () => "tenant" })
    const handle = await serveHttp(app, { port: 0, resolveServer: () => tenant })
    handles.push(handle)
    const request = modernRequest("tools/call", { name: "tenant_tool", arguments: {} })
    const response = await rawRequest(handle.url, { headers: request.headers, body: request.body })
    expect(response.status).toBe(200)
    expect(log).toEqual(["tenant_tool"])
  })
})
