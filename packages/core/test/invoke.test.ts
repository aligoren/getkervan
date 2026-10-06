import { describe, expect, it } from "vitest"
import { createApp, ToolError, z } from "../src/index.js"
import { connect, recordingLogger, textOf } from "./helpers.js"

function setup(options: Partial<Parameters<typeof createApp>[0]> = {}) {
  const logger = recordingLogger()
  const app = createApp({ name: "test", version: "0.0.0", logger, ...options })
  return { app, logger }
}

describe("results", () => {
  it("wraps a string in a text block", async () => {
    const { app } = setup()
    app.tool("greet", {
      description: "Greets",
      input: z.object({ name: z.string() }),
      handler: ({ name }) => `Hello, ${name}!`,
    })
    const client = await connect(app)
    const result = await client.callTool({ name: "greet", arguments: { name: "Ada" } })
    expect(result).toMatchObject({ content: [{ type: "text", text: "Hello, Ada!" }] })
    expect(result.isError).toBeFalsy()
  })

  it("passes a CallToolResult through", async () => {
    const { app } = setup()
    app.tool("raw", {
      description: "Raw",
      handler: () => ({
        content: [
          { type: "text", text: "a" },
          { type: "text", text: "b" },
        ],
      }),
    })
    const client = await connect(app)
    const result = await client.callTool({ name: "raw", arguments: {} })
    expect(result.content).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ])
  })

  it("builds structuredContent and a JSON text block from an output schema", async () => {
    const { app } = setup()
    app.tool("sum", {
      description: "Adds",
      input: z.object({ a: z.number(), b: z.number() }),
      output: z.object({ sum: z.number() }),
      handler: ({ a, b }) => ({ sum: a + b }),
    })
    const client = await connect(app)
    const result = await client.callTool({ name: "sum", arguments: { a: 2, b: 3 } })
    expect(result.structuredContent).toEqual({ sum: 5 })
    expect(textOf(result)).toBe('{"sum":5}')
  })

  it("advertises title, schemas and annotations", async () => {
    const { app } = setup()
    app.tool("sum", {
      title: "Sum",
      description: "Adds",
      input: z.object({ a: z.number().describe("First") }),
      output: z.object({ sum: z.number() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: ({ a }) => ({ sum: a }),
    })
    const client = await connect(app)
    const { tools } = await client.listTools()
    expect(tools[0]).toMatchObject({
      name: "sum",
      title: "Sum",
      description: "Adds",
      inputSchema: { type: "object", properties: { a: { type: "number", description: "First" } } },
      outputSchema: { type: "object", properties: { sum: { type: "number" } } },
      annotations: { readOnlyHint: true, openWorldHint: false },
    })
  })

  it("gives a tool without input an empty object schema", async () => {
    const { app } = setup()
    app.tool("ping", { description: "Ping", handler: () => "pong" })
    const client = await connect(app)
    const { tools } = await client.listTools()
    expect(tools[0]?.inputSchema).toMatchObject({ type: "object" })
    expect(textOf(await client.callTool({ name: "ping", arguments: {} }))).toBe("pong")
  })
})

describe("errors", () => {
  it("returns schema violations as tool errors without running the handler", async () => {
    const { app } = setup()
    let ran = false
    app.tool("limited", {
      description: "Limited",
      input: z.object({ n: z.number().max(5) }),
      handler: () => {
        ran = true
        return "ran"
      },
    })
    const client = await connect(app)
    const result = await client.callTool({ name: "limited", arguments: { n: 99 } })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/Input validation error/)
    expect(ran).toBe(false)
  })

  it("sends ToolError messages to the client", async () => {
    const { app } = setup()
    app.tool("find", {
      description: "Find",
      handler: () => {
        throw new ToolError('No city named "Atlantis". Try a real city.')
      },
    })
    const client = await connect(app)
    const result = await client.callTool({ name: "find", arguments: {} })
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: 'No city named "Atlantis". Try a real city.' }],
    })
  })

  it("masks unexpected errors and logs them with a reference", async () => {
    const { app, logger } = setup()
    app.tool("leaky", {
      description: "Leaky",
      handler: () => {
        throw new Error("connect failed: postgres://admin:s3cret@db.internal/prod")
      },
    })
    const client = await connect(app)
    const result = await client.callTool({ name: "leaky", arguments: {} })
    const text = textOf(result)
    expect(result.isError).toBe(true)
    expect(text).not.toContain("s3cret")
    expect(text).not.toContain("postgres")
    const ref = text.match(/ref: ([0-9a-f]{8})/)?.[1]
    expect(ref).toBeDefined()
    const logged = logger.entries.find((e) => e.level === "error")
    expect(logged?.message).toContain(`ref: ${ref}`)
    expect(String(logged?.data)).toContain("s3cret")
  })

  it("masks invalid return values and explains them in the log", async () => {
    const { app, logger } = setup()
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid return value
    app.tool("bad", { description: "Bad", handler: () => ({ answer: 42 }) as any })
    const client = await connect(app)
    const result = await client.callTool({ name: "bad", arguments: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/Internal error in tool "bad"/)
    expect(String(logger.entries.find((e) => e.level === "error")?.data)).toMatch(
      /declare an "output" schema/,
    )
  })

  it("times out slow handlers and aborts their signal", async () => {
    const { app } = setup({ limits: { toolTimeoutMs: 5_000 } })
    let aborted = false
    app.tool("slow", {
      description: "Slow",
      timeoutMs: 50,
      handler: (_input, ctx) =>
        new Promise<string>((resolve) => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true
            resolve("too late")
          })
        }),
    })
    const client = await connect(app)
    const result = await client.callTool({ name: "slow", arguments: {} })
    expect(result).toMatchObject({
      isError: true,
      content: [{ type: "text", text: 'Tool "slow" timed out after 50 ms.' }],
    })
    expect(aborted).toBe(true)
  })

  it("applies the app-wide timeout", async () => {
    const { app } = setup({ limits: { toolTimeoutMs: 30 } })
    app.tool("hang", { description: "Hang", handler: () => new Promise<string>(() => {}) })
    const client = await connect(app)
    const result = await client.callTool({ name: "hang", arguments: {} })
    expect(textOf(result)).toBe('Tool "hang" timed out after 30 ms.')
  })

  it("rejects oversized arguments", async () => {
    const { app } = setup({ limits: { maxToolInputElements: 10 } })
    app.tool("count", {
      description: "Count",
      input: z.object({ items: z.array(z.number()) }),
      handler: ({ items }) => String(items.length),
    })
    const client = await connect(app)
    const ok = await client.callTool({ name: "count", arguments: { items: [1, 2, 3] } })
    expect(textOf(ok)).toBe("3")
    const tooBig = await client.callTool({
      name: "count",
      arguments: { items: Array.from({ length: 50 }, (_, i) => i) },
    })
    expect(tooBig.isError).toBe(true)
  })
})

describe("context", () => {
  it("sends increasing progress and drops non-increasing values", async () => {
    const { app, logger } = setup()
    app.tool("work", {
      description: "Work",
      handler: async (_input, ctx) => {
        await ctx.progress(1, 3)
        await ctx.progress(1, 3)
        await ctx.progress(2, 3, "halfway")
        await ctx.progress(3, 3)
        return "done"
      },
    })
    const client = await connect(app)
    const updates: unknown[] = []
    await client.callTool(
      { name: "work", arguments: {} },
      { onprogress: (update) => updates.push(update) },
    )
    expect(updates).toEqual([
      { progress: 1, total: 3 },
      { progress: 2, total: 3, message: "halfway" },
      { progress: 3, total: 3 },
    ])
    expect(logger.entries.some((e) => e.message.includes("non-increasing"))).toBe(true)
  })

  it("treats progress as a no-op without a progress token", async () => {
    const { app } = setup()
    app.tool("work", {
      description: "Work",
      handler: async (_input, ctx) => {
        await ctx.progress(1)
        return "done"
      },
    })
    const client = await connect(app)
    expect(textOf(await client.callTool({ name: "work", arguments: {} }))).toBe("done")
  })

  it("writes ctx.log to the server logger, not the client, by default", async () => {
    const { app, logger } = setup()
    app.tool("chatty", {
      description: "Chatty",
      handler: (_input, ctx) => {
        ctx.log.info("working", { step: 1 })
        ctx.log.warning("careful")
        return "ok"
      },
    })
    const client = await connect(app)
    const received: unknown[] = []
    client.setNotificationHandler("notifications/message", (n) => {
      received.push(n)
    })
    await client.callTool({ name: "chatty", arguments: {} })
    expect(client.getServerCapabilities()?.logging).toBeUndefined()
    expect(received).toEqual([])
    expect(logger.entries).toContainEqual({
      level: "info",
      message: "working",
      data: { tool: "chatty", requestId: expect.anything(), data: { step: 1 } },
    })
    expect(logger.entries.some((e) => e.level === "warn" && e.message === "careful")).toBe(true)
  })

  it("declares logging only with protocolLogging, and never forwards without a logLevel", async () => {
    const { app } = setup({ protocolLogging: true })
    app.tool("chatty", {
      description: "Chatty",
      handler: (_input, ctx) => {
        ctx.log.info("working")
        return "ok"
      },
    })
    const client = await connect(app)
    const received: unknown[] = []
    client.setNotificationHandler("notifications/message", (n) => {
      received.push(n)
    })
    await client.callTool({ name: "chatty", arguments: {} })
    expect(client.getServerCapabilities()?.logging).toEqual({})
    expect(received).toEqual([])
  })
})
