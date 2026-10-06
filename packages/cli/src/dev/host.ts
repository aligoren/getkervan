import { inspect } from "node:util"
import { type App, createApp, jsonSchema, type Logger, rawResult, ToolError } from "@kervan/core"
import type { CallToolResult, Tool } from "@modelcontextprotocol/client"
import { ChildServer, type StopMethod } from "./child.js"
import type { Redactor } from "./redact.js"

export interface DevHostOptions {
  entry: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** How long a reload waits for in-flight calls on the old server. */
  drainTimeoutMs: number
  redact: Redactor
  /** Where host messages go (already redacted). */
  print: (line: string) => void
  startTimeoutMs?: number
}

/**
 * The stable server clients connect to during development. It runs the user's server in a child
 * process, mirrors its tools into its own registry (tools that did not change keep their entry,
 * so clients only get list_changed for real changes) and swaps the child on reload.
 */
export class DevHost {
  readonly app: App
  current: ChildServer | undefined

  readonly #options: DevHostOptions
  /** Tool name → serialized definition, to detect real changes. */
  readonly #signatures = new Map<string, string>()
  readonly #retiring = new Set<Promise<StopMethod>>()
  #queue: Promise<unknown> = Promise.resolve()
  #closed = false

  constructor(options: DevHostOptions) {
    this.#options = options
    this.app = createApp({
      name: "kervan-dev",
      version: "0.0.0",
      logger: redactingLogger(options.redact, options.print),
      // The child enforces its own timeouts; the host only guards against a hung child.
      limits: { toolTimeoutMs: 10 * 60_000 },
    })
  }

  /** Starts (or restarts) the server. Reloads run one at a time, in order. */
  reload(reason: string): Promise<boolean> {
    const run = this.#queue.then(() => this.#reload(reason))
    this.#queue = run.catch(() => {})
    return run
  }

  async #reload(reason: string): Promise<boolean> {
    if (this.#closed) return false
    const started = Date.now()
    let next: ChildServer
    try {
      next = await ChildServer.start({
        entry: this.#options.entry,
        cwd: this.#options.cwd,
        env: this.#options.env,
        ...(this.#options.startTimeoutMs ? { startTimeoutMs: this.#options.startTimeoutMs } : {}),
        onStderr: (line) => this.#print(`[server] ${line}`),
        onToolsChanged: (tools) => {
          if (next === this.current) {
            this.#sync(tools)
            this.#print(`Server changed its tools: ${tools.map((tool) => tool.name).join(", ")}`)
          }
        },
        onError: (error) => this.#print(`[server] ${error.message}`),
      })
    } catch (error) {
      const kept = this.current ? " Still serving the previous version." : ""
      this.#print(`Could not start the server (${reason}): ${(error as Error).message}${kept}`)
      return false
    }
    if (this.#closed) {
      await next.stop()
      return false
    }

    const previous = this.current
    this.current = next
    this.#sync(next.tools)
    this.#print(
      `${previous ? "Reloaded" : "Started"} (${reason}) in ${Date.now() - started} ms: ` +
        `${next.tools.length} tool${next.tools.length === 1 ? "" : "s"}`,
    )
    if (previous) this.#retire(previous)
    return true
  }

  #retire(server: ChildServer): void {
    if (server.inflight > 0) {
      this.#print(`Waiting for ${server.inflight} call(s) on the previous version to finish...`)
    }
    const done = server.retire(this.#options.drainTimeoutMs)
    this.#retiring.add(done)
    done.then(
      (method) => {
        this.#retiring.delete(done)
        if (method === "forced") this.#print("Stopped the previous version by force.")
      },
      () => this.#retiring.delete(done),
    )
  }

  /** Mirrors the child's tools into the registry, touching only tools that changed. */
  #sync(tools: Tool[]): void {
    const registry = this.app.registry
    const names = new Set(tools.map((tool) => tool.name))
    for (const name of [...this.#signatures.keys()]) {
      if (!names.has(name)) {
        registry.remove(name)
        this.#signatures.delete(name)
      }
    }
    for (const tool of tools) {
      const signature = JSON.stringify([
        tool.title,
        tool.description,
        tool.inputSchema,
        tool.outputSchema,
        tool.annotations,
      ])
      const previous = this.#signatures.get(tool.name)
      if (previous === signature) continue
      try {
        const definition = this.#proxy(tool)
        const method = previous === undefined ? "add" : "replace"
        if ("output" in definition) registry[method](tool.name, definition)
        else registry[method](tool.name, definition)
        this.#signatures.set(tool.name, signature)
      } catch (error) {
        this.#print(`Skipping tool "${tool.name}": ${(error as Error).message}`)
      }
    }
  }

  #proxy(tool: Tool) {
    const forward = async (input: unknown, ctx: Parameters<ChildServer["call"]>[2]) => {
      const server = this.current
      if (!server) {
        throw new ToolError("The dev server is not running. Check the terminal for errors.")
      }
      const result = await server.call(tool.name, input, ctx)
      return result.isError ? this.#redactResult(result) : result
    }
    const base = {
      ...(tool.title === undefined ? {} : { title: tool.title }),
      description: tool.description?.trim() || `${tool.name} (no description)`,
      input: jsonSchema(tool.inputSchema),
      ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
    }
    if (tool.outputSchema === undefined) return { ...base, handler: forward }
    return {
      ...base,
      output: jsonSchema(tool.outputSchema),
      handler: async (input: unknown, ctx: Parameters<ChildServer["call"]>[2]) =>
        rawResult(await forward(input, ctx)),
    }
  }

  #redactResult(result: CallToolResult): CallToolResult {
    return {
      ...result,
      content: result.content.map((block) =>
        block.type === "text" ? { ...block, text: this.#options.redact(block.text) } : block,
      ),
    }
  }

  #print(line: string): void {
    this.#options.print(this.#options.redact(line))
  }

  /** Stops the server, letting in-flight calls finish for up to the drain timeout. */
  async close(): Promise<void> {
    this.#closed = true
    await this.#queue
    const current = this.current
    this.current = undefined
    await Promise.all([current?.retire(this.#options.drainTimeoutMs), ...this.#retiring])
  }
}

/** A logger that redacts secrets before printing anything. */
export function redactingLogger(redact: Redactor, print: (line: string) => void): Logger {
  const write = (level: string) => (message: string, data?: unknown) => {
    const detail =
      data === undefined ? "" : ` ${inspect(data, { depth: 4, breakLength: Infinity })}`
    print(redact(`[kervan-dev] ${level}: ${message}${detail}`))
  }
  return { debug: () => {}, info: write("info"), warn: write("warn"), error: write("error") }
}
