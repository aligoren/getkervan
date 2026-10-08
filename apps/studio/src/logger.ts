import { inspect } from "node:util"
import type { Logger, LogLevel } from "@kervan/core"

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

/** How deep `inspect` prints data; deeper values are not shown, so they need no redaction. */
const DEPTH = 4

/**
 * Studio's logger: one line per entry on stderr, with every known secret value removed from the
 * message and from the serialized data (errors included) before anything is written.
 *
 * The data is redacted before `inspect` formats it, string by string: `inspect` escapes some
 * characters its own way (`\x1B`, `\'`) and cuts long strings, so a secret holding such
 * characters, or a long one, would no longer match its redaction patterns in the formatted text.
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
      data === undefined
        ? ""
        : ` ${inspect(redactData(data, redact), { depth: DEPTH, breakLength: Infinity })}`
    write(redact(`[kervan-studio] ${level}: ${message}${detail}`))
  }
  return { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") }
}

/**
 * A copy of `value` with every string (keys, error messages and stacks included) redacted. Bytes
 * are described, not shown: `inspect` would print them as hex, which no pattern matches.
 */
export function redactData(
  value: unknown,
  redact: (text: string) => string,
  depth = 0,
  seen = new Map<object, unknown>(),
): unknown {
  if (typeof value === "string") return redact(value)
  if (typeof value === "number" || typeof value === "bigint") {
    const text = String(value)
    return redact(text) === text ? value : redact(text)
  }
  if (typeof value === "symbol") return redact(value.toString())
  if (typeof value === "function") return `[Function ${redact(value.name)}]`
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return seen.get(value)
  if (depth > DEPTH) return "[Object]"
  const next = (item: unknown) => redactData(item, redact, depth + 1, seen)

  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return `[${value.constructor.name}: ${value.byteLength} bytes]`
  }
  if (value instanceof Date || value instanceof RegExp) return redact(String(value))
  if (value instanceof Error) {
    const copy = new Error(redact(value.message))
    seen.set(value, copy)
    copy.name = redact(value.name)
    copy.stack = redact(value.stack ?? `${value.name}: ${value.message}`)
    if ("cause" in value) copy.cause = next(value.cause)
    for (const [key, item] of Object.entries(value)) {
      ;(copy as unknown as Record<string, unknown>)[redact(key)] = next(item)
    }
    return copy
  }
  if (Array.isArray(value)) {
    const copy: unknown[] = []
    seen.set(value, copy)
    for (const item of value) copy.push(next(item))
    return copy
  }
  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>()
    seen.set(value, copy)
    for (const [key, item] of value) copy.set(next(key), next(item))
    return copy
  }
  if (value instanceof Set) {
    const copy = new Set<unknown>()
    seen.set(value, copy)
    for (const item of value) copy.add(next(item))
    return copy
  }
  const copy: Record<string, unknown> = {}
  seen.set(value, copy)
  for (const [key, item] of Object.entries(value)) copy[redact(key)] = next(item)
  return copy
}
