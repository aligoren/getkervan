import { describe, expect, it } from "vitest"
import { createApp, KervanDefinitionError, silentLogger, z } from "../src/index.js"

const newApp = () => createApp({ name: "test", version: "0.0.0", logger: silentLogger })
const handler = () => "ok"

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn()
  } catch (error) {
    if (error instanceof KervanDefinitionError) return error.code
    throw error
  }
  return undefined
}

describe("tool names", () => {
  it.each(["get_weather", "a", "files.read", "user-profile", "A1_b.c-d", "x".repeat(128)])(
    "accepts %j",
    (name) => {
      expect(codeOf(() => newApp().tool(name, { description: "d", handler }))).toBeUndefined()
    },
  )

  it.each(["", "has space", "x".repeat(129), "çay", "a/b", "a:b"])("rejects %j", (name) => {
    expect(codeOf(() => newApp().tool(name, { description: "d", handler }))).toBe(
      "INVALID_TOOL_NAME",
    )
  })

  it("rejects duplicates", () => {
    const app = newApp().tool("t", { description: "d", handler })
    expect(codeOf(() => app.tool("t", { description: "d", handler }))).toBe("DUPLICATE_TOOL")
  })
})

describe("tool definitions", () => {
  it("requires a description", () => {
    expect(codeOf(() => newApp().tool("t", { description: "  ", handler }))).toBe(
      "MISSING_DESCRIPTION",
    )
  })

  it("requires an object input schema", () => {
    const app = newApp()
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
    const bad = (input: any) => () => app.tool("t", { description: "d", input, handler })
    expect(codeOf(bad(z.string()))).toBe("INVALID_INPUT_SCHEMA")
    expect(codeOf(bad({ city: z.string() }))).toBe("INVALID_INPUT_SCHEMA")
    expect(codeOf(bad({ type: "object" }))).toBe("INVALID_INPUT_SCHEMA")
  })

  it("requires a Zod output schema", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid output
    const output: any = { type: "object" }
    expect(codeOf(() => newApp().tool("t", { description: "d", output, handler }))).toBe(
      "INVALID_OUTPUT_SCHEMA",
    )
  })

  it("requires a handler function", () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid handler
    const bad: any = "nope"
    expect(codeOf(() => newApp().tool("t", { description: "d", handler: bad }))).toBe(
      "INVALID_HANDLER",
    )
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])("rejects timeoutMs %j", (timeoutMs) => {
    expect(codeOf(() => newApp().tool("t", { description: "d", timeoutMs, handler }))).toBe(
      "INVALID_TIMEOUT",
    )
  })

  it("lists tools in registration order", () => {
    const app = newApp()
    for (const name of ["zeta", "alpha", "mid"]) app.tool(name, { description: name, handler })
    expect(app.listTools().map((t) => t.name)).toEqual(["zeta", "alpha", "mid"])
  })
})

describe("app options", () => {
  it.each([
    { name: "", version: "1" },
    { name: "x", version: "" },
    { name: "x", version: "1", limits: { toolTimeoutMs: 0 } },
    { name: "x", version: "1", limits: { maxToolInputElements: 0 } },
  ])("rejects %j", (options) => {
    expect(codeOf(() => createApp(options))).toBe("INVALID_APP_OPTIONS")
  })

  it("puts the code in the message", () => {
    expect(() => createApp({ name: "", version: "1" })).toThrow(/^\[INVALID_APP_OPTIONS\]/)
  })
})
