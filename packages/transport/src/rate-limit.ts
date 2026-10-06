import type { Context, MiddlewareHandler } from "hono"

export interface RateLimitOptions {
  /** Window length in milliseconds. Default: 60 000. */
  windowMs?: number
  /** Requests allowed per key per window. Default: 300. */
  max?: number
  /**
   * Derives the client key from a request. The Node default is the socket's remote address;
   * proxy headers such as `X-Forwarded-For` are not trusted unless you read them here.
   */
  keyGenerator?: (c: Context) => string | Promise<string>
}

export const DEFAULT_RATE_LIMIT = { windowMs: 60_000, max: 300 } as const

/** In-memory fixed-window limiter. State is per process, so it does not coordinate across instances. */
export function rateLimiter(
  options: RateLimitOptions & Required<Pick<RateLimitOptions, "keyGenerator">>,
): MiddlewareHandler {
  const windowMs = options.windowMs ?? DEFAULT_RATE_LIMIT.windowMs
  const max = options.max ?? DEFAULT_RATE_LIMIT.max
  if (!(windowMs > 0) || !(max >= 1)) {
    throw new RangeError("rateLimit.windowMs must be > 0 and rateLimit.max must be >= 1")
  }
  const windows = new Map<string, { count: number; resetAt: number }>()
  let nextSweep = 0

  return async (c, next) => {
    const now = Date.now()
    if (now >= nextSweep) {
      for (const [key, window] of windows) if (window.resetAt <= now) windows.delete(key)
      nextSweep = now + windowMs
    }
    const key = await options.keyGenerator(c)
    let window = windows.get(key)
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + windowMs }
      windows.set(key, window)
    }
    window.count += 1
    if (window.count > max) {
      c.header("Retry-After", String(Math.ceil((window.resetAt - now) / 1000)))
      return c.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Too many requests" }, id: null },
        429,
      )
    }
    return next()
  }
}
