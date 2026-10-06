import { type AuthInfo, LOG_LEVEL_META_KEY, type ServerContext } from "@modelcontextprotocol/server"
import type { Logger } from "./logger.js"

export type ToolLogLevel = "debug" | "info" | "warning" | "error"

export type ToolLogFn = (message: string, data?: unknown) => void

export interface ToolLogger {
  debug: ToolLogFn
  info: ToolLogFn
  warning: ToolLogFn
  error: ToolLogFn
}

/** Per-call context handed to every tool handler. */
export interface ToolContext {
  readonly toolName: string
  readonly requestId: string | number
  /** Aborts when the client cancels the call or the tool times out. Forward it to your own I/O. */
  readonly signal: AbortSignal
  /** Validated auth info passed in by the HTTP layer; `undefined` on stdio or unauthenticated routes. */
  readonly auth: AuthInfo | undefined
  /** Writes to the server logger (stderr). See `AppOptions.protocolLogging` for client-visible logs. */
  readonly log: ToolLogger
  /**
   * Reports progress when the client asked for it (sent a progress token); otherwise a no-op.
   * Values must increase between calls; a non-increasing value is dropped with a warning.
   */
  progress(progress: number, total?: number, message?: string): Promise<void>
  /** The underlying SDK context, for features Kervan does not wrap yet. */
  readonly raw: ServerContext
}

export interface ContextOptions {
  toolName: string
  signal: AbortSignal
  logger: Logger
  protocolLogging: boolean
}

export interface ToolContextHandle {
  ctx: ToolContext
  /** Marks the call finished: later progress or protocol log calls are ignored. */
  close(): void
}

const loggerMethod = { debug: "debug", info: "info", warning: "warn", error: "error" } as const

export function createToolContext(raw: ServerContext, options: ContextOptions): ToolContextHandle {
  const { toolName, logger } = options
  const requestId = raw.mcpReq.id
  const progressToken = raw.mcpReq._meta?.progressToken
  const envelope = raw.mcpReq.envelope as Record<string, unknown> | undefined
  // Protocol logs are opt-in twice: the app must enable them and the request must carry a log level.
  const forwardLogs = options.protocolLogging && envelope?.[LOG_LEVEL_META_KEY] !== undefined
  let closed = false
  let lastProgress = Number.NEGATIVE_INFINITY

  const makeLog =
    (level: ToolLogLevel): ToolLogFn =>
    (message, data) => {
      const fields = { tool: toolName, requestId, ...(data === undefined ? {} : { data }) }
      logger[loggerMethod[level]](message, fields)
      if (!forwardLogs || closed) return
      const payload = data === undefined ? message : { message, data }
      raw.mcpReq.log(level, payload, toolName).catch((error: unknown) => {
        logger.debug("Failed to forward a log message to the client", { tool: toolName, error })
      })
    }

  const ctx: ToolContext = {
    toolName,
    requestId,
    signal: options.signal,
    auth: raw.http?.authInfo,
    log: {
      debug: makeLog("debug"),
      info: makeLog("info"),
      warning: makeLog("warning"),
      error: makeLog("error"),
    },
    async progress(progress, total, message) {
      if (progressToken === undefined || closed) return
      if (!(progress > lastProgress)) {
        logger.warn("Dropped a non-increasing progress value", {
          tool: toolName,
          progress,
          previous: lastProgress,
        })
        return
      }
      lastProgress = progress
      await raw.mcpReq.notify({
        method: "notifications/progress",
        params: {
          progressToken,
          progress,
          ...(total === undefined ? {} : { total }),
          ...(message === undefined ? {} : { message }),
        },
      })
    },
    raw,
  }

  return {
    ctx,
    close() {
      closed = true
    },
  }
}
