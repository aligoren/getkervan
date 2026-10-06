import { createTestClient } from "@kervan/transport/testing"
import { describe, expect, it } from "vitest"
import { app } from "../src/app.ts"

describe("{{name}}", () => {
  it("greets", async () => {
    const client = await createTestClient(app)
    const result = await client.callTool({ name: "greet", arguments: { name: "Ada" } })
    expect(result.content).toEqual([{ type: "text", text: "Hello, Ada!" }])
    await client.close()
  })

  it("explains division by zero to the model", async () => {
    const client = await createTestClient(app)
    const result = await client.callTool({ name: "divide", arguments: { a: 1, b: 0 } })
    expect(result.isError).toBe(true)
    await client.close()
  })
})
