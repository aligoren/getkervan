import { createHash } from "node:crypto"

/** A versioned 32-byte key for AES-256-GCM. */
export interface MasterKey {
  version: number
  key: Buffer
}

/**
 * Where the vault's master keys come from. `current` encrypts; `get` decrypts rows written under
 * an older version, so a key can be rotated without downtime.
 */
export interface KeyProvider {
  current(): MasterKey
  get(version: number): Buffer | undefined
}

export class KeyError extends Error {
  override name = "KeyError"
}

/** How to make a key: printed when one is missing. */
export const KEY_HINT =
  "node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\""

/**
 * Reads `KERVAN_STUDIO_MASTER_KEY` (`[version:]base64`, 32 bytes; version 1 when omitted) and
 * `KERVAN_STUDIO_PREVIOUS_MASTER_KEYS` (comma-separated `version:base64`, for rotation).
 * Studio does not start without a current key.
 */
export function envKeyProvider(env: NodeJS.ProcessEnv): KeyProvider {
  const raw = env.KERVAN_STUDIO_MASTER_KEY?.trim()
  if (!raw) {
    throw new KeyError(
      "KERVAN_STUDIO_MASTER_KEY is not set. Studio encrypts secrets with it and does not start " +
        `without one. Create one with:\n  ${KEY_HINT}\nKeep it outside the data directory and ` +
        "back it up: secrets cannot be read without it.",
    )
  }
  const current = parseKey(raw, "KERVAN_STUDIO_MASTER_KEY", 1)
  const keys = new Map([[current.version, current.key]])
  for (const entry of (env.KERVAN_STUDIO_PREVIOUS_MASTER_KEYS ?? "").split(",")) {
    if (entry.trim() === "") continue
    const previous = parseKey(entry.trim(), "KERVAN_STUDIO_PREVIOUS_MASTER_KEYS")
    if (keys.has(previous.version)) {
      throw new KeyError(`Master key version ${previous.version} is given twice.`)
    }
    keys.set(previous.version, previous.key)
  }
  return staticKeyProvider(current, keys)
}

/** A provider over fixed keys (tests, or keys loaded from elsewhere). */
export function staticKeyProvider(
  current: MasterKey,
  keys = new Map<number, Buffer>(),
): KeyProvider {
  const all = new Map(keys)
  all.set(current.version, current.key)
  return { current: () => current, get: (version) => all.get(version) }
}

function parseKey(text: string, name: string, defaultVersion?: number): MasterKey {
  const match = /^(?:(\d{1,6}):)?([A-Za-z0-9+/_-]+={0,2})$/.exec(text)
  const version = match?.[1] === undefined ? defaultVersion : Number(match[1])
  if (!match?.[2] || version === undefined || version < 1) {
    throw new KeyError(
      `${name} must be [version:]base64 of 32 random bytes${defaultVersion ? "" : " with a version"}.`,
    )
  }
  const key = Buffer.from(match[2].replaceAll("-", "+").replaceAll("_", "/"), "base64")
  if (key.length !== 32) {
    throw new KeyError(`${name} must decode to exactly 32 bytes (got ${key.length}).`)
  }
  return { version, key }
}

/** A short, non-secret fingerprint of a key, for logs ("which key is this"). */
export function keyFingerprint(key: Buffer): string {
  return createHash("sha256").update("kervan-key-id:").update(key).digest("hex").slice(0, 8)
}
