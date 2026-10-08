import { SPEC_LIMITS } from "./spec-schema.js"

/** Where a secret is about to be sent. */
export interface SecretContext {
  /**
   * Host and port the request goes to, normalized and always with the port, e.g.
   * `api.example.com:443` (see `normalizeHostPort`).
   */
  host: string
  /** The tool making the request. */
  tool: string
}

/**
 * Where `{{secrets.NAME}}` values come from. Implementations must never log values.
 *
 * The runtime always passes `context` with the host the value is about to be sent to. A source
 * that binds secrets to hosts returns `undefined` for a host it does not allow; the call then
 * fails without sending anything. A spec's own `hosts` list can only narrow this further.
 */
export interface SecretSource {
  get(name: string, context?: SecretContext): string | undefined | Promise<string | undefined>
}

/** Reads secrets from environment variables of the same name. */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): SecretSource {
  return { get: (name) => env[name] }
}

/**
 * Normalizes a `host` or `host:port` binding the way URLs do (lowercase, IDNA, IPv4 forms) to
 * `host:port`, with port 443 when none is given. Returns `undefined` for anything else (schemes,
 * paths, wildcards). Bindings compare normalized values exactly.
 */
export function normalizeHostPort(entry: string): string | undefined {
  if (!/^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.?|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/.test(entry)) {
    return undefined
  }
  try {
    const url = new URL(`https://${entry}/`)
    return url.hostname === "" ? undefined : `${url.hostname}:${url.port || "443"}`
  } catch {
    return undefined
  }
}

/** The `host:port` a URL connects to, as bindings compare it. */
export function urlHostPort(url: URL): string {
  const port = url.port || (url.protocol === "http:" ? "80" : "443")
  return `${url.hostname}:${port}`
}

export const REDACTED = "[redacted]"

export class SecretError extends Error {
  override name = "SecretError"
}

/**
 * Remembers every secret value the runtime has used and scrubs it from text and JSON values,
 * including the encoded forms a value takes in URLs and JSON strings.
 */
export class SecretVault {
  #needles: string[] = []

  /** Registers a value; rejects values short enough to cause false matches when redacting. */
  add(name: string, value: string): void {
    if (value.length < SPEC_LIMITS.minSecretLength) {
      throw new SecretError(
        `Secret ${name} is shorter than ${SPEC_LIMITS.minSecretLength} characters. Short values ` +
          "cannot be redacted reliably; use a longer secret.",
      )
    }
    // An unpaired surrogate has no URL or UTF-8 form, so its encoded forms could not be listed.
    if (/\p{Cs}/u.test(value)) {
      throw new SecretError(
        `Secret ${name} is not valid Unicode text (it has an unpaired surrogate).`,
      )
    }
    const forms = new Set([
      value,
      encodeURIComponent(value),
      new URLSearchParams({ v: value }).toString().slice(2),
      JSON.stringify(value).slice(1, -1),
    ])
    const needles = new Set([...this.#needles, ...forms])
    this.#needles = [...needles].sort((a, b) => b.length - a.length)
  }

  get size(): number {
    return this.#needles.length
  }

  redact(text: string): string {
    let result = text
    for (const needle of this.#needles) result = result.split(needle).join(REDACTED)
    return result
  }

  /**
   * Parses JSON text and redacts it like `redactValue`. A number is checked as the upstream wrote
   * it: a long numeric secret loses digits when parsed, and would no longer match as a value.
   */
  parseJson(text: string): unknown {
    const data: unknown = JSON.parse(text, (...args: unknown[]) => {
      const [, value, context] = args as [string, unknown, { source?: string } | undefined]
      const source = context?.source
      if (typeof value === "number" && source !== undefined && this.redact(source) !== source) {
        return REDACTED
      }
      return value
    })
    return this.redactValue(data)
  }

  /**
   * Redacts every string inside a JSON value, and turns a number that holds a secret into the
   * redaction marker (an upstream may echo a numeric key as a number).
   */
  redactValue<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T
    if (typeof value === "number") {
      const text = String(value)
      return (this.redact(text) === text ? value : REDACTED) as T
    }
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item)) as T
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [this.redact(key), this.redactValue(item)]),
      ) as T
    }
    return value
  }
}
