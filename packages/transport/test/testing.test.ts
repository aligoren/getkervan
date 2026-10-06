import type { Client } from "@modelcontextprotocol/client"
import { afterEach, describe, expect, it } from "vitest"
import { createTestClient } from "../src/testing.js"
import { demoApp } from "./helpers.js"

const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

async function connect(...args: Parameters<typeof createTestClient>) {
  const client = await createTestClient(...args)
  clients.push(client)
  return client
}

describe.each(["modern", "legacy"] as const)("createTestClient (%s era)", (era) => {
  it("negotiates the requested era", async () => {
    const client = await connect(demoApp(), { era })
    expect(client.getProtocolEra()).toBe(era)
  })

  it("lists tools with their metadata", async () => {
    const client = await connect(demoApp(), { era })
    const { tools } = await client.listTools()
    expect(tools.find((tool) => tool.name === "add")).toMatchObject({
      title: "Add",
      description: "Adds two numbers",
      inputSchema: { type: "object", required: ["a", "b"] },
      outputSchema: { type: "object", properties: { sum: { type: "number" } } },
      annotations: { readOnlyHint: true, openWorldHint: false },
    })
  })

  it("calls a tool with structured output", async () => {
    const client = await connect(demoApp(), { era })
    const result = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } })
    expect(result.structuredContent).toEqual({ sum: 5 })
    expect(result.isError).toBeFalsy()
  })

  it("returns invalid input and ToolError as tool errors", async () => {
    const client = await connect(demoApp(), { era })
    const invalid = await client.callTool({ name: "add", arguments: { a: "two", b: 3 } })
    expect(invalid.isError).toBe(true)
    const failed = await client.callTool({ name: "alpha", arguments: { fail: true } })
    expect(failed).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "alpha failed on purpose" }],
    })
  })

  it("keeps tools/list in registration order", async () => {
    const client = await connect(demoApp(), { era })
    const names = async () => (await client.listTools()).tools.map((tool) => tool.name)
    const expected = ["zeta", "add", "alpha", "whoami"]
    expect(await names()).toEqual(expected)
    expect(await names()).toEqual(expected)
  })
})

describe("createTestClient auth", () => {
  it("passes authInfo to tools as ctx.auth", async () => {
    const client = await connect(demoApp(), {
      authInfo: { token: "t", clientId: "client-42", scopes: [] },
    })
    const result = await client.callTool({ name: "whoami", arguments: {} })
    expect(result.content).toEqual([{ type: "text", text: "client-42" }])
  })

  it("leaves ctx.auth undefined without authInfo", async () => {
    const client = await connect(demoApp())
    const result = await client.callTool({ name: "whoami", arguments: {} })
    expect(result.content).toEqual([{ type: "text", text: "anonymous" }])
  })
})
