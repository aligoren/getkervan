import { describe, expect, it } from "vitest"
import {
  createApp,
  type KervanDefinitionError,
  ToolError,
  type ToolMiddleware,
  z,
} from "../src/index.js"
import { connect, recordingLogger, textOf } from "./helpers.js"

function setup(options: { toolTimeoutMs?: number } = {}) {
  const logger = recordingLogger()
  const app = createApp({
    name: "mw",
    version: "0.0.0",
    logger,
    ...(options.toolTimeoutMs ? { limits: { toolTimeoutMs: options.toolTimeoutMs } } : {}),
  })
  return { app, logger }
}

const tracer =
  (label: string, trace: string[]): ToolMiddleware =>
  async (_call, next) => {
    trace.push(`${label}:before`)
    const result = await next()
    trace.push(`${label}:after`)
    return result
  }

describe("middleware", () => {
  it("runs app middleware, then tool middleware, then the handler, and unwinds in reverse", async () => {
    const { app } = setup()
    const trace: string[] = []
    app.use(tracer("app1", trace)).use(tracer("app2", trace))
    app.tool("t", {
      description: "d",
      middleware: [tracer("tool1", trace), tracer("tool2", trace)],
      handler: () => {
        trace.push("handler")
        return "ok"
      },
    })
    const client = await connect(app)
    expect(textOf(await client.callTool({ name: "t", arguments: {} }))).toBe("ok")
    expect(trace).toEqual([
      "app1:before",
      "app2:before",
      "tool1:before",
      "tool2:before",
      "handler",
      "tool2:after",
      "tool1:after",
      "app2:after",
      "app1:after",
    ])
  })

  it("sees the validated input, tool info and context", async () => {
    const { app } = setup()
    const seen: unknown[] = []
    app.use((call, next) => {
      seen.push({
        tool: call.tool,
        input: call.input,
        requestId: typeof call.ctx.requestId,
        signal: call.ctx.signal instanceof AbortSignal,
      })
      return next()
    })
    app.tool("sum", {
      title: "Sum",
      description: "adds",
      input: z.object({ a: z.number(), b: z.number().default(10) }),
      annotations: { readOnlyHint: true },
      handler: ({ a, b }) => String(a + b),
    })
    const client = await connect(app)
    await client.callTool({ name: "sum", arguments: { a: 1 } })
    expect(seen).toEqual([
      {
        tool: {
          name: "sum",
          title: "Sum",
          description: "adds",
          annotations: { readOnlyHint: true },
        },
        input: { a: 1, b: 10 },
        requestId: "number",
        signal: true,
      },
    ])
  })

  it("can short-circuit without calling the handler", async () => {
    const { app } = setup()
    let ran = false
    app.use((call, next) =>
      call.tool.annotations?.destructiveHint
        ? { content: [{ type: "text", text: "Blocked by policy." }], isError: true }
        : next(),
    )
    app.tool("drop_db", {
      description: "d",
      annotations: { destructiveHint: true },
      handler: () => {
        ran = true
        return "dropped"
      },
    })
    const client = await connect(app)
    const result = await client.callTool({ name: "drop_db", arguments: {} })
    expect(result).toMatchObject({ isError: true, content: [{ text: "Blocked by policy." }] })
    expect(ran).toBe(false)
  })

  it("can transform the result", async () => {
    const { app } = setup()
    app.use(async (_call, next) => {
      const result = await next()
      return { ...result, content: [...result.content, { type: "text", text: " (audited)" }] }
    })
    app.tool("t", { description: "d", handler: () => "done" })
    const client = await connect(app)
    expect(textOf(await client.callTool({ name: "t", arguments: {} }))).toBe("done (audited)")
  })

  it("lets ToolError from middleware reach the client and masks other errors", async () => {
    const { app, logger } = setup()
    app.use((call, next) => {
      if (call.tool.name === "denied") throw new ToolError("You may not call this tool.")
      if (call.tool.name === "broken") throw new Error("vault token=sk-live-123 rejected")
      return next()
    })
    app.tool("denied", { description: "d", handler: () => "x" })
    app.tool("broken", { description: "d", handler: () => "x" })
    const client = await connect(app)
    expect(textOf(await client.callTool({ name: "denied", arguments: {} }))).toBe(
      "You may not call this tool.",
    )
    const broken = textOf(await client.callTool({ name: "broken", arguments: {} }))
    expect(broken).toMatch(/^Internal error in tool "broken" \(ref: [0-9a-f]{8}\)\.$/)
    expect(broken).not.toContain("sk-live")
    expect(String(logger.entries.at(-1)?.data)).toContain("sk-live-123")
  })

  it("passes handler errors through middleware as exceptions", async () => {
    const { app } = setup()
    const caught: string[] = []
    app.use(async (_call, next) => {
      try {
        return await next()
      } catch (error) {
        caught.push((error as Error).message)
        throw error
      }
    })
    app.tool("t", {
      description: "d",
      handler: () => {
        throw new ToolError("handler said no")
      },
    })
    const client = await connect(app)
    expect(textOf(await client.callTool({ name: "t", arguments: {} }))).toBe("handler said no")
    expect(caught).toEqual(["handler said no"])
  })

  it("applies the tool timeout to slow middleware", async () => {
    const { app } = setup({ toolTimeoutMs: 40 })
    app.use(() => new Promise(() => {}))
    app.tool("t", { description: "d", handler: () => "never" })
    const client = await connect(app)
    expect(textOf(await client.callTool({ name: "t", arguments: {} }))).toBe(
      'Tool "t" timed out after 40 ms.',
    )
  })

  it("rejects calling next() twice", async () => {
    const { app, logger } = setup()
    let handlerRuns = 0
    app.use(async (_call, next) => {
      await next()
      return next()
    })
    app.tool("t", {
      description: "d",
      handler: () => {
        handlerRuns++
        return "x"
      },
    })
    const client = await connect(app)
    const result = await client.callTool({ name: "t", arguments: {} })
    expect(result.isError).toBe(true)
    expect(handlerRuns).toBe(1)
    expect(String(logger.entries.at(-1)?.data)).toContain("next() called more than once")
  })

  it("masks a middleware that returns something other than a CallToolResult", async () => {
    const { app, logger } = setup()
    // biome-ignore lint/suspicious/noExplicitAny: deliberately wrong return value
    app.use((() => ({ nope: true })) as any)
    app.tool("t", { description: "d", handler: () => "x" })
    const client = await connect(app)
    const result = await client.callTool({ name: "t", arguments: {} })
    expect(textOf(result)).toMatch(/Internal error in tool "t"/)
    expect(String(logger.entries.at(-1)?.data)).toContain("instead of a CallToolResult")
  })

  it("validates middleware definitions", () => {
    const { app } = setup()
    const codeOf = (fn: () => unknown) => {
      try {
        fn()
      } catch (error) {
        return (error as KervanDefinitionError).code
      }
    }
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
    const bad: any = ["not a function"]
    expect(
      codeOf(() => app.tool("t", { description: "d", middleware: bad, handler: () => "" })),
    ).toBe("INVALID_MIDDLEWARE")
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
    expect(codeOf(() => app.use("nope" as any))).toBe("INVALID_MIDDLEWARE")
  })
})
