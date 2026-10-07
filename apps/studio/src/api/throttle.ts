import { rateLimitKey } from "../client-ip.js"

export interface ThrottleOptions {
  /** Failures allowed per account within `windowMs` before it is locked. Default: 5. */
  accountFailures?: number
  /** Failures allowed per client IP (IPv6: per /64) within `windowMs`. Default: 20. */
  ipFailures?: number
  /** Window for counting failures, and how long a lock lasts. Default: 15 minutes. */
  windowMs?: number
  /** For tests. Default: `Date.now`. */
  clock?: () => number
}

interface Counter {
  /** When the recent failures happened, oldest first (at most the limit's worth). */
  failures: number[]
  /** Attempts that started and have not finished: they count against the limit too. */
  inFlight: number
  lockedUntil: number
}

/** What a caller does with an attempt: finish it with the outcome, or wait. */
export type Attempt = { retryAfter: number } | { done: (succeeded: boolean) => void }

/**
 * Counts failed logins (per account and per client IP) and failed setup-token guesses (per client
 * IP, in their own namespace), and locks after too many. An attempt reserves its place before the
 * slow password check, so a burst of concurrent guesses cannot get past the limit. Unknown
 * accounts are counted like real ones, so a lock does not reveal whether an account exists.
 */
export class LoginThrottle {
  readonly #accountFailures: number
  readonly #ipFailures: number
  readonly #windowMs: number
  readonly #clock: () => number
  readonly #counters = new Map<string, Counter>()
  #nextSweep = 0

  constructor(options: ThrottleOptions = {}) {
    this.#accountFailures = options.accountFailures ?? 5
    this.#ipFailures = options.ipFailures ?? 20
    this.#windowMs = options.windowMs ?? 15 * 60 * 1000
    this.#clock = options.clock ?? Date.now
  }

  /** Starts a login attempt for `account` from `ip`. */
  login(account: string, ip: string): Attempt {
    const normalized = account.trim().toLowerCase()
    return this.#begin(
      [
        [`login:account:${normalized}`, this.#accountFailures],
        [`login:ip:${rateLimitKey(ip)}`, this.#ipFailures],
      ],
      true,
    )
  }

  /** Starts a setup-token attempt from `ip` (per IP only: nobody can lock setup for everyone). */
  setup(ip: string): Attempt {
    return this.#begin([[`setup:ip:${rateLimitKey(ip)}`, this.#ipFailures]], false)
  }

  get size(): number {
    return this.#counters.size
  }

  #begin(keys: [string, number][], clearAccountOnSuccess: boolean): Attempt {
    const now = this.#clock()
    this.#sweep(now)
    // Looked up without creating: refused attempts add no counters (a locked IP trying new
    // account names would otherwise grow the map).
    let wait = 0
    for (const [key, limit] of keys) {
      const counter = this.#counters.get(key)
      if (!counter) continue
      this.#forgetOld(counter, now)
      if (counter.lockedUntil > now) wait = Math.max(wait, counter.lockedUntil - now)
      else if (counter.failures.length + counter.inFlight >= limit) wait = Math.max(wait, 1000)
    }
    if (wait > 0) return { retryAfter: Math.ceil(wait / 1000) }
    const counters = keys.map(([key, limit]) => [this.#counter(key), limit] as const)
    for (const [counter] of counters) counter.inFlight++
    let finished = false
    return {
      done: (succeeded) => {
        if (finished) return
        finished = true
        const at = this.#clock()
        counters.forEach(([counter, limit], index) => {
          counter.inFlight--
          if (succeeded) {
            // A successful login clears the account's failures (the IP's stay).
            if (clearAccountOnSuccess && index === 0) counter.failures = []
            return
          }
          this.#forgetOld(counter, at)
          counter.failures.push(at)
          if (counter.failures.length > limit) counter.failures.shift()
          if (counter.failures.length >= limit) counter.lockedUntil = at + this.#windowMs
        })
      },
    }
  }

  #counter(key: string): Counter {
    let counter = this.#counters.get(key)
    if (!counter) {
      counter = { failures: [], inFlight: 0, lockedUntil: 0 }
      this.#counters.set(key, counter)
    }
    return counter
  }

  /**
   * Drops failures older than the window. The window slides: no more than the limit's worth of
   * failures get through in any `windowMs`, also across what a fixed window's boundary would be.
   */
  #forgetOld(counter: Counter, now: number): void {
    while (counter.failures.length > 0 && now - (counter.failures[0] ?? now) > this.#windowMs) {
      counter.failures.shift()
    }
  }

  /** Forgets idle counters, at most once per window (not on every request). */
  #sweep(now: number): void {
    if (now < this.#nextSweep) return
    this.#nextSweep = now + this.#windowMs
    for (const [key, counter] of this.#counters) {
      this.#forgetOld(counter, now)
      const idle = counter.inFlight === 0 && counter.lockedUntil <= now
      if (idle && counter.failures.length === 0) this.#counters.delete(key)
    }
  }
}
