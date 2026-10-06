import { type CacheHint, McpServer, type RegisteredTool } from "@modelcontextprotocol/server"
import * as z from "zod"
import { KervanDefinitionError } from "./errors.js"
import { createConsoleLogger, type Logger } from "./logger.js"
import {
  InMemoryToolRegistry,
  type MutableToolRegistry,
  sameEntries,
  type ToolEntry,
  type ToolRegistry,
} from "./registry.js"
import {
  type AnyObjectSchema,
  type AnyToolDefinition,
  invokeTool,
  type NoInput,
  type StructuredToolDefinition,
  type ToolDefinition,
  type ToolMiddleware,
} from "./tool.js"

export interface AppLimits {
  /** Default per-call tool timeout in milliseconds. Default: 30 000. */
  toolTimeoutMs?: number
  /**
   * Maximum combined number of array elements and object members in one call's arguments.
   * Default: 10 000. Use `Infinity` to disable.
   */
  maxToolInputElements?: number
}

export interface AppOptions {
  name: string
  version: string
  /** Human-readable server name. */
  title?: string
  /** Server-level guidance sent to clients. */
  instructions?: string
  /** Server-side logger. Default: `console.error` (stderr), level `info`. */
  logger?: Logger
  /**
   * Also forward `ctx.log` calls to the client as MCP log notifications. Off by default because
   * MCP logging is deprecated as of protocol 2026-07-28. Even when on, a message is only sent
   * for requests whose `_meta` carries `io.modelcontextprotocol/logLevel`.
   */
  protocolLogging?: boolean
  /**
   * Cache hint for `tools/list` results (protocol 2026-07-28). Default: none, which means
   * `ttlMs: 0` and `cacheScope: "private"`, so clients never serve a stale tool list.
   */
  listCache?: CacheHint
  limits?: AppLimits
  /** Where `app.tool()` registers tools. Default: a new `InMemoryToolRegistry`. */
  registry?: MutableToolRegistry
}

export interface ToolInfo {
  name: string
  title: string | undefined
  description: string
}

/** An SDK server kept in sync with a registry for the lifetime of one connection. */
export interface LiveServer {
  server: McpServer
  /** Stops following the registry. Also runs when the server closes. */
  dispose(): void
}

export interface App {
  readonly name: string
  readonly version: string
  readonly logger: Logger
  /** The app's own tool set. Transports serve it unless a `resolveServer` hook picks another. */
  readonly registry: MutableToolRegistry
  /** Registers a tool. Throws `KervanDefinitionError` on an invalid or duplicate definition. */
  tool<I extends AnyObjectSchema = NoInput>(name: string, definition: ToolDefinition<I>): App
  tool<I extends AnyObjectSchema = NoInput, O extends z.ZodType = z.ZodType>(
    name: string,
    definition: StructuredToolDefinition<I, O>,
  ): App
  /** Replaces a registered tool in place. Connected clients are notified. */
  replaceTool<I extends AnyObjectSchema = NoInput>(name: string, definition: ToolDefinition<I>): App
  replaceTool<I extends AnyObjectSchema = NoInput, O extends z.ZodType = z.ZodType>(
    name: string,
    definition: StructuredToolDefinition<I, O>,
  ): App
  /** Removes a tool. Connected clients are notified. Returns `false` if it did not exist. */
  removeTool(name: string): boolean
  /**
   * Adds middleware around every tool call, in registration order (first added = outermost).
   * Applies immediately, to every registry this app serves.
   */
  use(middleware: ToolMiddleware): App
  /** Tools of the app's registry, in order. */
  listTools(): ToolInfo[]
  /**
   * Builds a fresh SDK server from a snapshot of `registry` (default: the app's). Used per
   * HTTP request, where every request sees the current tool set.
   */
  createServer(registry?: ToolRegistry): McpServer
  /**
   * Builds an SDK server that follows `registry` and sends `list_changed` when it changes.
   * Used for long-lived connections (stdio, in-memory).
   */
  createLiveServer(registry?: ToolRegistry): LiveServer
}

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000
export const DEFAULT_MAX_TOOL_INPUT_ELEMENTS = 10_000

const emptyInput = z.object({})

export function createApp(options: AppOptions): App {
  validateAppOptions(options)
  const logger = options.logger ?? createConsoleLogger()
  const toolTimeoutMs = options.limits?.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS
  const maxToolInputElements =
    options.limits?.maxToolInputElements ?? DEFAULT_MAX_TOOL_INPUT_ELEMENTS
  const protocolLogging = options.protocolLogging ?? false
  const middleware: ToolMiddleware[] = []
  const registry =
    options.registry ??
    new InMemoryToolRegistry({
      onListenerError: (error) => logger.error("Tool registry listener failed", error),
    })

  const newServer = () =>
    new McpServer(
      {
        name: options.name,
        version: options.version,
        ...(options.title ? { title: options.title } : {}),
      },
      {
        ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
        // Declared up front so an empty registry still answers tools/list and clients
        // still open a list_changed subscription.
        capabilities: {
          tools: { listChanged: true },
          ...(protocolLogging ? { logging: {} } : {}),
        },
        debouncedNotificationMethods: ["notifications/tools/list_changed"],
        ...(options.listCache === undefined
          ? {}
          : { cacheHints: { "tools/list": options.listCache } }),
        maxToolInputElements,
      },
    )

  const register = (server: McpServer, tool: ToolEntry): RegisteredTool => {
    const timeoutMs = tool.timeoutMs ?? toolTimeoutMs
    return server.registerTool(
      tool.name,
      {
        ...(tool.title === undefined ? {} : { title: tool.title }),
        description: tool.description,
        inputSchema: tool.input ?? emptyInput,
        ...(tool.output === undefined ? {} : { outputSchema: tool.output }),
        ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
      },
      (input, raw) =>
        invokeTool(tool, input, raw, { timeoutMs, logger, protocolLogging, middleware }),
    )
  }

  const app: App = {
    name: options.name,
    version: options.version,
    logger,
    registry,

    tool(name: string, definition: AnyToolDefinition) {
      registry.add(name, definition as ToolDefinition)
      return app
    },

    replaceTool(name: string, definition: AnyToolDefinition) {
      registry.replace(name, definition as ToolDefinition)
      return app
    },

    removeTool(name) {
      return registry.remove(name)
    },

    use(fn) {
      if (typeof fn !== "function") {
        throw new KervanDefinitionError("INVALID_MIDDLEWARE", "app.use() expects a function.")
      }
      middleware.push(fn)
      return app
    },

    listTools() {
      return registry.list().map(({ name, title, description }) => ({ name, title, description }))
    },

    createServer(source = registry) {
      const server = newServer()
      for (const tool of source.list()) register(server, tool)
      return server
    },

    createLiveServer(source = registry) {
      const server = newServer()
      let current = source.list()
      let handles = current.map((tool) => register(server, tool))

      const sync = () => {
        const next = source.list()
        if (sameEntries(current, next)) return
        // Re-register everything so the SDK's order always matches the registry (update() cannot
        // move a tool or clear optional fields). The SDK coalesces the notifications into one.
        for (const handle of handles) handle.remove()
        handles = next.map((tool) => register(server, tool))
        current = next
      }

      const unsubscribe = source.onChange(() => {
        try {
          sync()
        } catch (error) {
          logger.error("Failed to apply a tool registry change to a live server", error)
        }
      })
      let disposed = false
      const dispose = () => {
        if (disposed) return
        disposed = true
        unsubscribe()
      }
      const close = server.close.bind(server)
      server.close = async () => {
        dispose()
        await close()
      }
      return { server, dispose }
    },
  }
  return app
}

function validateAppOptions(options: AppOptions): void {
  const fail = (message: string) => {
    throw new KervanDefinitionError("INVALID_APP_OPTIONS", message)
  }
  if (typeof options?.name !== "string" || options.name.trim() === "") fail('"name" is required.')
  if (typeof options.version !== "string" || options.version.trim() === "") {
    fail('"version" is required.')
  }
  const { toolTimeoutMs, maxToolInputElements } = options.limits ?? {}
  if (toolTimeoutMs !== undefined && !(Number.isFinite(toolTimeoutMs) && toolTimeoutMs > 0)) {
    fail('"limits.toolTimeoutMs" must be a positive number of milliseconds.')
  }
  if (maxToolInputElements !== undefined && !(maxToolInputElements >= 1)) {
    fail('"limits.maxToolInputElements" must be at least 1 (or Infinity to disable).')
  }
}
