export interface ThrottleOptions {
  /** Failures allowed per account within `windowMs` before it is locked. Default: 5. */
  accountFailures?: number
  /** Failures allowed per client IP within `windowMs` before it is locked. Default: 20. */
  ipFailures?: number
  /** Window for counting failures, and how long a lock lasts. Default: 15 minutes. */
  windowMs?: number
}

interface Counter {
  failures: number
  windowStart: number
  lockedUntil: number
}

/**
 * Counts failed logins per account and per client IP and locks either after too many. Unknown
 * accounts are counted like real ones, so a lock does not reveal whether an account exists.
 */
export class LoginThrottle {
  readonly #accountFailures: number
  readonly #ipFailures: number
  readonly #windowMs: number
  readonly #counters = new Map<string, Counter>()

  constructor(options: ThrottleOptions = {}) {
    this.#accountFailures = options.accountFailures ?? 5
    this.#ipFailures = options.ipFailures ?? 20
    this.#windowMs = options.windowMs ?? 15 * 60 * 1000
  }

  /** Seconds until the account or IP may try again, or 0 if they may now. */
  retryAfter(account: string, ip: string, now = Date.now()): number {
    this.#sweep(now)
    const until = Math.max(
      this.#counters.get(accountKey(account))?.lockedUntil ?? 0,
      this.#counters.get(ipKey(ip))?.lockedUntil ?? 0,
    )
    return until > now ? Math.ceil((until - now) / 1000) : 0
  }

  failed(account: string, ip: string, now = Date.now()): void {
    this.#count(accountKey(account), this.#accountFailures, now)
    this.#count(ipKey(ip), this.#ipFailures, now)
  }

  /** A successful login clears the account's failures (the IP's stay). */
  succeeded(account: string): void {
    this.#counters.delete(accountKey(account))
  }

  #count(key: string, limit: number, now: number): void {
    let counter = this.#counters.get(key)
    if (!counter || now - counter.windowStart >= this.#windowMs) {
      counter = { failures: 0, windowStart: now, lockedUntil: counter?.lockedUntil ?? 0 }
      this.#counters.set(key, counter)
    }
    counter.failures += 1
    if (counter.failures >= limit) counter.lockedUntil = now + this.#windowMs
  }

  #sweep(now: number): void {
    if (this.#counters.size < 10_000) return
    for (const [key, counter] of this.#counters) {
      if (counter.lockedUntil <= now && now - counter.windowStart >= this.#windowMs) {
        this.#counters.delete(key)
      }
    }
  }
}

const accountKey = (account: string) => `account:${account.trim().toLowerCase()}`
const ipKey = (ip: string) => `ip:${ip}`
