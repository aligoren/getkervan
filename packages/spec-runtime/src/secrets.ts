import { SPEC_LIMITS } from "./spec-schema.js"

/** Where a secret is about to be sent. */
export interface SecretContext {
  /** Host name the request goes to (normalized: lowercase, no port), e.g. `api.example.com`. */
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
 * Normalizes a host name the way URLs do (lowercase, IDNA, IPv4 forms), or returns `undefined`
 * if it is not a bare host name. Bindings compare normalized names exactly.
 */
export function normalizeHost(host: string): string | undefined {
  if (!/^(?:[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.?|\[[0-9A-Fa-f:.]+\])$/.test(host)) return undefined
  try {
    const url = new URL(`https://${host}/`)
    return url.port === "" && url.hostname !== "" ? url.hostname : undefined
  } catch {
    return undefined
  }
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

  /** Redacts every string inside a JSON value. */
  redactValue<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T
    if (Array.isArray(value)) return value.map((item) => this.redactValue(item)) as T
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [this.redact(key), this.redactValue(item)]),
      ) as T
    }
    return value
  }
}
