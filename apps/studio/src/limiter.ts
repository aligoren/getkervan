/** A fixed-window counter per key, in memory (one Studio process). */
export class FixedWindowLimiter {
  readonly #windowMs: number
  readonly #max: number
  readonly #windows = new Map<string, { count: number; resetAt: number }>()
  #nextSweep = 0

  constructor(options: { windowMs: number; max: number }) {
    this.#windowMs = options.windowMs
    this.#max = options.max
  }

  /** Counts a hit; returns the seconds to wait if the key is over its limit, else 0. */
  hit(key: string, now = Date.now()): number {
    if (now >= this.#nextSweep) {
      for (const [k, window] of this.#windows) if (window.resetAt <= now) this.#windows.delete(k)
      this.#nextSweep = now + this.#windowMs
    }
    let window = this.#windows.get(key)
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.#windowMs }
      this.#windows.set(key, window)
    }
    window.count += 1
    return window.count > this.#max ? Math.ceil((window.resetAt - now) / 1000) : 0
  }

  get size(): number {
    return this.#windows.size
  }
}
