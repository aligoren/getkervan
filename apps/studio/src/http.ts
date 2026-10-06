import { getConnInfo } from "@hono/node-server/conninfo"
import { type Context, Hono } from "hono"
import { clientIp, rateLimitKey } from "./client-ip.js"
import { allowedHostNames, type StudioConfig } from "./config.js"
import { GATEWAY_PATH } from "./gateway.js"
import { FixedWindowLimiter } from "./limiter.js"
import type { Studio } from "./studio.js"

export interface StudioHttpOptions {
  /** Requests per client IP per minute, across Studio. Default: 1200. */
  ipRateLimit?: number
}

export type StudioEnv = { Variables: { clientIp: string } }

/** Headers on every response. The web UI (4b) adds its own Content-Security-Policy for pages. */
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
}

/**
 * Studio's HTTP surface. Everything shares the checks here: the `Host` header must name Studio's
 * public host (DNS rebinding), every client IP has a request budget, and security headers are set
 * on every response. The MCP gateway is mounted at `/s/{serverId}/mcp`.
 */
export function createStudioHttp(
  studio: Studio,
  config: Pick<StudioConfig, "publicUrl" | "trustProxy">,
  options: StudioHttpOptions = {},
): Hono<StudioEnv> {
  const hosts = new Set(allowedHostNames(config))
  const limiter = new FixedWindowLimiter({ windowMs: 60_000, max: options.ipRateLimit ?? 1200 })
  const app = new Hono<StudioEnv>()

  app.use("*", async (c, next) => {
    await next()
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      if (!c.res.headers.has(name)) c.res.headers.set(name, value)
    }
  })

  app.use("*", async (c, next) => {
    if (!hosts.has(hostName(c.req.header("host")))) {
      return c.json({ error: "Unknown host" }, 403)
    }
    const ip = clientIp(socketAddress(c), c.req.header("x-forwarded-for"), config.trustProxy)
    c.set("clientIp", ip)
    const wait = limiter.hit(rateLimitKey(ip))
    if (wait > 0) {
      c.header("retry-after", String(wait))
      return c.json({ error: "Too many requests" }, 429)
    }
    return next()
  })

  app.all(GATEWAY_PATH, (c) => studio.gateway.fetch(c.req.raw))

  app.notFound((c) => c.json({ error: "Not found" }, 404))
  app.onError((error, c) => {
    const ref = crypto.randomUUID().slice(0, 8)
    studio.gateway.app.logger.error(`HTTP request failed (ref: ${ref})`, error)
    return c.json({ error: `Internal error (ref: ${ref})` }, 500)
  })
  return app
}

const HOST_HEADER = /^(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(?::\d{1,5})?$/

/** The host name of a `Host` header, lowercase and without the port; "" if malformed. */
function hostName(header: string | undefined): string {
  const match = HOST_HEADER.exec(header ?? "")
  return match?.[1] ? match[1].toLowerCase() : ""
}

function socketAddress(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address
  } catch {
    // Not served by @hono/node-server (e.g. app.fetch in tests): there is no socket.
    return undefined
  }
}
