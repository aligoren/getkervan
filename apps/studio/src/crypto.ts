import {
  createHash,
  randomBytes,
  type ScryptOptions,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto"

/** A URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url")
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** Compares two strings in time that depends only on their lengths. */
export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8")
  const right = Buffer.from(b, "utf8")
  return left.length === right.length && timingSafeEqual(left, right)
}

// scrypt with N = 2^15, r = 8, p = 1 (about 32 MiB and tens of milliseconds per hash).
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const
const SCRYPT_MAXMEM = 64 * 1024 * 1024

export const MIN_PASSWORD_LENGTH = 12
export const MAX_PASSWORD_LENGTH = 1024

function scrypt(password: string, salt: Buffer, keyLength: number, options: ScryptOptions) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password.normalize("NFKC"), salt, keyLength, options, (error, key) =>
      error ? reject(error) : resolve(key),
    )
  })
}

/** Hashes a password as `scrypt$N$r$p$salt$hash` (base64url parts). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT.saltLength)
  const { N, r, p, keyLength } = SCRYPT
  const key = await scrypt(password, salt, keyLength, { N, r, p, maxmem: SCRYPT_MAXMEM })
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$")
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split("$")
  if (kind !== "scrypt" || !n || !r || !p || !salt || !hash) return false
  const expected = Buffer.from(hash, "base64url")
  const key = await scrypt(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT_MAXMEM,
  })
  return key.length === expected.length && timingSafeEqual(key, expected)
}

/** Why a password is not acceptable, or `undefined` if it is. */
export function passwordProblem(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `The password must have at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `The password must have at most ${MAX_PASSWORD_LENGTH} characters.`
  }
  return undefined
}
