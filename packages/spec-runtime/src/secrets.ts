import { SPEC_LIMITS } from "./spec-schema.js"

/** Where `{{secrets.NAME}}` values come from. Implementations must never log values. */
export interface SecretSource {
  get(name: string): string | undefined | Promise<string | undefined>
}

/** Reads secrets from environment variables of the same name. */
export function envSecrets(env: NodeJS.ProcessEnv = process.env): SecretSource {
  return { get: (name) => env[name] }
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
