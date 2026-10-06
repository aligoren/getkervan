import { inspect } from "node:util"
import type { Logger, LogLevel } from "@kervan/core"

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/**
 * Studio's logger: one line per entry on stderr, with every known secret value removed from the
 * message and from the serialized data (errors included) before anything is written.
 */
export function studioLogger(
  redact: (text: string) => string,
  options: { level?: LogLevel; write?: (line: string) => void } = {},
): Logger {
  const min = order[options.level ?? "info"]
  const write = options.write ?? ((line: string) => process.stderr.write(`${line}\n`))
  const log = (level: LogLevel) => (message: string, data?: unknown) => {
    if (order[level] < min) return
    const detail =
      data === undefined ? "" : ` ${inspect(data, { depth: 4, breakLength: Infinity })}`
    write(redact(`[kervan-studio] ${level}: ${message}${detail}`))
  }
  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") }
}
