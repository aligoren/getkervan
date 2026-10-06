// Compile-time checks: `tsc -p tsconfig.test.json` fails if the handler typing regresses.
import { describe, expectTypeOf, it } from "vitest"
import { createApp, silentLogger, type ToolContext, z } from "../src/index.js"

const app = createApp({ name: "types", version: "0.0.0", logger: silentLogger })

describe("handler typing", () => {
  it("infers input from the schema", () => {
    app.tool("typed", {
      description: "d",
      input: z.object({ city: z.string(), days: z.number().optional() }),
      handler: (input, ctx) => {
        expectTypeOf(input).toEqualTypeOf<{ city: string; days?: number | undefined }>()
        expectTypeOf(ctx).toEqualTypeOf<ToolContext>()
        return input.city
      },
    })
  })

  it("accepts an inline CallToolResult", () => {
    app.tool("inline", {
      description: "d",
      handler: async () => ({ content: [{ type: "text", text: "hi" }], isError: false }),
    })
  })

  it("requires the output type when an output schema is set", () => {
    app.tool("structured", {
      description: "d",
      output: z.object({ sum: z.number() }),
      handler: () => ({ sum: 1 }),
    })
    app.tool("structured-wrong", {
      description: "d",
      output: z.object({ sum: z.number() }),
      // @ts-expect-error a string is not the declared output
      handler: () => "nope",
    })
  })

  it("rejects non-result values without an output schema", () => {
    // @ts-expect-error plain objects need an output schema
    app.tool("untyped-wrong", { description: "d", handler: () => ({ sum: 1 }) })
  })
})
