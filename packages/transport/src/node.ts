import type { AddressInfo } from "node:net"
import { serve as serveNode } from "@hono/node-server"
import { getConnInfo } from "@hono/node-server/conninfo"
import type { App, ToolRegistry } from "@kervan/core"
import {
  type StdioServerHandle,
  serveStdio as sdkServeStdio,
} from "@modelcontextprotocol/server/stdio"
import { Hono } from "hono"
import { type FetchHandlerOptions, type KervanHttpHandler, toFetchHandler } from "./index.js"
import { DEFAULT_RATE_LIMIT, type RateLimitOptions, rateLimiter } from "./rate-limit.js"

export type { RateLimitOptions } from "./rate-limit.js"

export interface StdioOptions {
  /** `"serve"` (default) also serves 2025-era clients; `"reject"` serves 2026-07-28 only. */
  legacy?: "serve" | "reject"
  /** Tool set to serve. Default: the app's registry. Changes are pushed as `list_changed`. */
  registry?: ToolRegistry
}

/** Serves the app over stdin/stdout. Logs must go to stderr; Kervan's default logger does. */
export function serveStdio(app: App, options: StdioOptions = {}): StdioServerHandle {
  // The factory runs once per connection (plus once for a discarded discovery probe); each live
  // server stops following the registry when the SDK closes it.
  return sdkServeStdio(() => app.createLiveServer(options.registry).server, {
    ...(options.legacy === undefined ? {} : { legacy: options.legacy }),
    onerror: (error) => app.logger.error("stdio transport error", error),
  })
}

export interface HttpOptions extends FetchHandlerOptions {
  /** Default: 3000. Use 0 for a random free port. */
  port?: number
  /** Interface to bind. Default: `"127.0.0.1"`. */
  host?: string
  /** Per-client rate limit, on by default (300 requests/minute per socket address). `false` disables it. */
  rateLimit?: RateLimitOptions | false
}

export interface HttpServerHandle {
  /** The MCP endpoint, e.g. `http://127.0.0.1:3000/mcp`. */
  url: URL
  port: number
  handler: KervanHttpHandler
  close(): Promise<void>
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"])

/**
 * Serves the app over Streamable HTTP on Node. Resolves once the server is listening. Binding to
 * anything but loopback needs `allowedHosts` (the host names clients use): without the list there
 * would be no `Host` check, and any web page could reach the server through DNS rebinding.
 */
export function serveHttp(app: App, options: HttpOptions = {}): Promise<HttpServerHandle> {
  const host = options.host ?? "127.0.0.1"
  if (!LOOPBACK.has(host) && (options.allowedHosts?.length ?? 0) === 0) {
    return Promise.reject(
      new Error(
        `Serving on ${host} needs allowedHosts: the host names clients use (Host header ` +
          "validation against DNS rebinding). Bind to 127.0.0.1, or list the host names.",
      ),
    )
  }
  const path = options.path ?? "/mcp"
  const handler = toFetchHandler(app, { ...options, host, path })

  const outer = new Hono()
  if (options.rateLimit !== false) {
    outer.use(
      "*",
      rateLimiter({
        ...DEFAULT_RATE_LIMIT,
        keyGenerator: (c) => getConnInfo(c).remote.address ?? "unknown",
        ...options.rateLimit,
      }),
    )
  }
  outer.all("*", (c) => handler.fetch(c.req.raw, c.env))

  return new Promise((resolve, reject) => {
    const server = serveNode(
      { fetch: outer.fetch, port: options.port ?? 3000, hostname: host },
      (info: AddressInfo) => {
        server.off("error", reject)
        const urlHost = info.family === "IPv6" ? `[${info.address}]` : info.address
        resolve({
          url: new URL(path, `http://${urlHost}:${info.port}`),
          port: info.port,
          handler,
          close: async () => {
            await handler.close()
            await new Promise<void>((done) => {
              server.close(() => done())
              if ("closeAllConnections" in server) server.closeAllConnections()
            })
          },
        })
      },
    )
    server.once("error", reject)
  })
}

export interface ServeOptions {
  /** Default: `--http`/`--stdio` flag, then `KERVAN_TRANSPORT`, then `"stdio"`. */
  transport?: "stdio" | "http"
  http?: HttpOptions
  stdio?: StdioOptions
}

/**
 * Starts the app on stdio or HTTP and closes it on SIGINT/SIGTERM. HTTP port and host also read
 * `--port=`, `PORT`, `--host=` and `HOST`.
 */
export async function serve(app: App, options: ServeOptions = {}): Promise<void> {
  const args = process.argv.slice(2)
  const transport = options.transport ?? pickTransport(args, process.env.KERVAN_TRANSPORT)
  let close: () => Promise<void>

  if (transport === "http") {
    const port = Number(flag(args, "port") ?? process.env.PORT ?? options.http?.port ?? 3000)
    const host = flag(args, "host") ?? process.env.HOST ?? options.http?.host
    let handle: HttpServerHandle
    try {
      handle = await serveHttp(app, {
        ...options.http,
        port,
        ...(host === undefined ? {} : { host }),
      })
    } catch (error) {
      // One line, not a stack trace: a port in use, or a host that needs allowedHosts.
      app.logger.error(`Cannot serve ${app.name}: ${(error as Error).message}`)
      process.exitCode = 1
      return
    }
    app.logger.info(`${app.name} listening on ${handle.url.href}`)
    close = handle.close
  } else {
    const handle = serveStdio(app, options.stdio)
    close = () => handle.close()
  }

  const shutdown = (signal: string) => {
    app.logger.info(`Received ${signal}, shutting down`)
    close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.logger.error("Shutdown failed", error)
        process.exit(1)
      },
    )
  }
  process.once("SIGINT", () => shutdown("SIGINT"))
  process.once("SIGTERM", () => shutdown("SIGTERM"))
}

function pickTransport(args: string[], env: string | undefined): "stdio" | "http" {
  if (args.includes("--http")) return "http"
  if (args.includes("--stdio")) return "stdio"
  if (env === "http" || env === "stdio") return env
  return "stdio"
}

function flag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length)
}
