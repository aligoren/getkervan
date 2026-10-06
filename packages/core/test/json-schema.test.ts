import { describe, expect, it } from "vitest"
import {
  createApp,
  jsonSchema,
  type KervanDefinitionError,
  rawResult,
  silentLogger,
} from "../src/index.js"
import { connect, textOf } from "./helpers.js"

const newApp = () => createApp({ name: "json", version: "0.0.0", logger: silentLogger })

const cityInput = jsonSchema<{ city: string; days?: number }>({
  type: "object",
  properties: { city: { type: "string", minLength: 1 }, days: { type: "integer", maximum: 7 } },
  required: ["city"],
  additionalProperties: false,
})

describe("jsonSchema input and output", () => {
  it("advertises the JSON Schema and validates arguments against it", async () => {
    const app = newApp()
    const seen: unknown[] = []
    app.tool("forecast", {
      description: "d",
      input: cityInput,
      handler: (input) => {
        seen.push(input)
        return `${input.city} for ${input.days ?? 1} days`
      },
    })
    const client = await connect(app)
    const [tool] = (await client.listTools()).tools
    expect(tool?.inputSchema).toMatchObject({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    })

    const ok = await client.callTool({ name: "forecast", arguments: { city: "Izmir", days: 3 } })
    expect(textOf(ok)).toBe("Izmir for 3 days")
    const invalid = await client.callTool({ name: "forecast", arguments: { days: 30 } })
    expect(invalid.isError).toBe(true)
    expect(seen).toEqual([{ city: "Izmir", days: 3 }])
  })

  it("rejects a JSON Schema input that is not an object schema", () => {
    const app = newApp()
    const code = (() => {
      try {
        app.tool("t", {
          description: "d",
          input: jsonSchema({ type: "string" }),
          handler: () => "",
        })
      } catch (error) {
        return (error as KervanDefinitionError).code
      }
    })()
    expect(code).toBe("INVALID_INPUT_SCHEMA")
  })

  it("uses a JSON Schema output for structuredContent", async () => {
    const app = newApp()
    app.tool("sum", {
      description: "d",
      output: jsonSchema<{ sum: number }>({
        type: "object",
        properties: { sum: { type: "number" } },
        required: ["sum"],
      }),
      handler: () => ({ sum: 3 }),
    })
    const client = await connect(app)
    const [tool] = (await client.listTools()).tools
    expect(tool?.outputSchema).toMatchObject({ properties: { sum: { type: "number" } } })
    expect((await client.callTool({ name: "sum", arguments: {} })).structuredContent).toEqual({
      sum: 3,
    })
  })
})

describe("rawResult", () => {
  it("forwards a complete result from a tool with an output schema", async () => {
    const app = newApp()
    const output = jsonSchema({ type: "object", properties: { n: { type: "number" } } })
    app.tool("forward", {
      description: "d",
      output,
      handler: () =>
        rawResult({ content: [{ type: "text", text: "n is 1" }], structuredContent: { n: 1 } }),
    })
    app.tool("forward_error", {
      description: "d",
      output,
      handler: () =>
        rawResult({ content: [{ type: "text", text: "upstream failed" }], isError: true }),
    })
    const client = await connect(app)
    expect(await client.callTool({ name: "forward", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "n is 1" }],
      structuredContent: { n: 1 },
    })
    expect(await client.callTool({ name: "forward_error", arguments: {} })).toMatchObject({
      content: [{ type: "text", text: "upstream failed" }],
      isError: true,
    })
  })
})
