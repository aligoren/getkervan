export type LogLevel = "debug" | "info" | "warn" | "error"

/** Server-side logger. Implementations must never write to stdout (it carries stdio JSON-RPC). */
export interface Logger {
  debug(message: string, data?: unknown): void
  info(message: string, data?: unknown): void
  warn(message: string, data?: unknown): void
  error(message: string, data?: unknown): void
}

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface ConsoleLoggerOptions {
  /** Minimum level to emit. Default: `"info"`. */
  level?: LogLevel
}

/**
 * Logger that writes every level through `console.error`, which is stderr on Node
 * and the platform log on Workers/Deno/Bun.
 */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const min = order[options.level ?? "info"]
  const write = (level: LogLevel, message: string, data: unknown) => {
    if (order[level] < min) return
    const line = `[kervan] ${level}: ${message}`
    if (data === undefined) console.error(line)
    else console.error(line, data)
  }
  return {
    debug: (message, data) => write("debug", message, data),
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
  }
}

export const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
}
