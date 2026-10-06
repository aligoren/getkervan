import { type CacheHint, McpServer } from "@modelcontextprotocol/server"
import * as z from "zod"
import { KervanDefinitionError } from "./errors.js"
import { createConsoleLogger, type Logger } from "./logger.js"
import {
  type AnyObjectSchema,
  type AnyToolDefinition,
  invokeTool,
  type NoInput,
  type RegisteredToolDefinition,
  type StructuredToolDefinition,
  type ToolDefinition,
  validateToolDefinition,
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
}

export interface ToolInfo {
  name: string
  title: string | undefined
  description: string
}

export interface App {
  readonly name: string
  readonly version: string
  readonly logger: Logger
  /** Registers a tool. Throws `KervanDefinitionError` on an invalid or duplicate definition. */
  tool<I extends AnyObjectSchema = NoInput>(name: string, definition: ToolDefinition<I>): App
  tool<I extends AnyObjectSchema = NoInput, O extends z.ZodType = z.ZodType>(
    name: string,
    definition: StructuredToolDefinition<I, O>,
  ): App
  /** Registered tools, in registration order. */
  listTools(): ToolInfo[]
  /** Builds a fresh SDK server with every registered tool. Transports call this per request or connection. */
  createServer(): McpServer
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
  // Map preserves insertion order, which keeps tools/list deterministic.
  const tools = new Map<string, RegisteredToolDefinition>()

  const app: App = {
    name: options.name,
    version: options.version,
    logger,

    tool(name: string, definition: AnyToolDefinition) {
      const tool = validateToolDefinition(name, definition)
      if (tools.has(name)) {
        throw new KervanDefinitionError(
          "DUPLICATE_TOOL",
          `A tool named "${name}" is already registered.`,
        )
      }
      tools.set(name, tool)
      return app
    },

    listTools() {
      return [...tools.values()].map(({ name, title, description }) => ({
        name,
        title,
        description,
      }))
    },

    createServer() {
      const server = new McpServer(
        {
          name: options.name,
          version: options.version,
          ...(options.title ? { title: options.title } : {}),
        },
        {
          ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
          ...(protocolLogging ? { capabilities: { logging: {} } } : {}),
          ...(options.listCache === undefined
            ? {}
            : { cacheHints: { "tools/list": options.listCache } }),
          maxToolInputElements,
        },
      )
      for (const tool of tools.values()) {
        const timeoutMs = tool.timeoutMs ?? toolTimeoutMs
        server.registerTool(
          tool.name,
          {
            ...(tool.title === undefined ? {} : { title: tool.title }),
            description: tool.description,
            inputSchema: tool.input ?? emptyInput,
            ...(tool.output === undefined ? {} : { outputSchema: tool.output }),
            ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
          },
          (input, raw) => invokeTool(tool, input, raw, { timeoutMs, logger, protocolLogging }),
        )
      }
      return server
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
