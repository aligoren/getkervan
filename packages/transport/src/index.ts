import type { App } from "@kervan/core"
import { createMcpHonoApp } from "@modelcontextprotocol/hono"
import {
  type AuthInfo,
  type CreateMcpHandlerOptions,
  createMcpHandler,
  type McpHttpHandler,
} from "@modelcontextprotocol/server"
import type { Context, Hono } from "hono"

export type { AuthInfo } from "@modelcontextprotocol/server"

/**
 * Verifies the caller. Return `AuthInfo` to accept, a `Response` (e.g. a 401 with a
 * `WWW-Authenticate` challenge) to reject, or `undefined` to continue unauthenticated.
 */
export type Authenticate = (
  request: Request,
) => AuthInfo | Response | undefined | Promise<AuthInfo | Response | undefined>

export interface FetchHandlerOptions {
  /** Route that serves MCP. Default: `"/mcp"`. */
  path?: string
  /**
   * Host the server is bound to. With a localhost-class value (the default, `"127.0.0.1"`) and no
   * explicit lists, only localhost `Host` and `Origin` headers are accepted (DNS rebinding protection).
   */
  host?: string
  /** Hostnames accepted in the `Host` header (port-agnostic). Required for public deployments. */
  allowedHosts?: string[]
  /** Hostnames accepted in the `Origin` header. Requests without `Origin` always pass. */
  allowedOrigins?: string[]
  /** Request body limit in bytes. Default: 4 MiB. */
  maxRequestBodySize?: number
  /** Response shaping for 2026-07-28 requests: `"auto"` (default), `"json"` or `"sse"`. */
  responseMode?: CreateMcpHandlerOptions["responseMode"]
  /** `"stateless"` (default) also serves 2025-era clients; `"reject"` serves 2026-07-28 only. */
  legacy?: CreateMcpHandlerOptions["legacy"]
  authenticate?: Authenticate
}

export interface KervanHttpHandler {
  /** Web-standard fetch handler: `export default handler` works on Workers, Deno and Bun. */
  fetch: (request: Request, env?: unknown, executionCtx?: unknown) => Response | Promise<Response>
  /** The underlying Hono app, for mounting extra routes or middleware. */
  hono: Hono
  /** The underlying SDK handler (change notifications, event bus). */
  mcp: McpHttpHandler
  /** Aborts in-flight requests and open subscription streams. */
  close(): Promise<void>
}

/**
 * Serves an app over Streamable HTTP as a web-standard fetch handler. Validates `Host`/`Origin`,
 * bounds the body size and serves both protocol eras statelessly; a fresh SDK server handles each
 * request.
 */
export function toFetchHandler(app: App, options: FetchHandlerOptions = {}): KervanHttpHandler {
  const path = options.path ?? "/mcp"
  const mcp = createMcpHandler(() => app.createServer(), {
    ...(options.legacy === undefined ? {} : { legacy: options.legacy }),
    ...(options.responseMode === undefined ? {} : { responseMode: options.responseMode }),
    ...(options.maxRequestBodySize === undefined
      ? {}
      : { maxRequestBodySize: options.maxRequestBodySize }),
    onerror: (error) => app.logger.debug("MCP HTTP handler reported an error", error),
  })

  const hono = createMcpHonoApp({
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
    ...(options.allowedOrigins === undefined ? {} : { allowedOrigins: options.allowedOrigins }),
    ...(options.maxRequestBodySize === undefined
      ? {}
      : { maxRequestBodySize: options.maxRequestBodySize }),
  })

  hono.all(path, async (c: Context) => {
    const parsedBody: unknown = c.get("parsedBody")
    let authInfo: AuthInfo | undefined
    if (options.authenticate) {
      const outcome = await options.authenticate(c.req.raw)
      if (outcome instanceof Response) return outcome
      authInfo = outcome
    }
    return mcp.fetch(c.req.raw, {
      ...(parsedBody === undefined ? {} : { parsedBody }),
      ...(authInfo === undefined ? {} : { authInfo }),
    })
  })

  hono.onError((error, c) => {
    const ref = crypto.randomUUID().slice(0, 8)
    app.logger.error(`HTTP request failed (ref: ${ref})`, error)
    return c.json(
      {
        jsonrpc: "2.0",
        error: { code: -32603, message: `Internal error (ref: ${ref})` },
        id: null,
      },
      500,
    )
  })

  return {
    fetch: (request, env, executionCtx) =>
      hono.fetch(request, env, executionCtx as Parameters<Hono["fetch"]>[2]),
    hono,
    mcp,
    close: () => mcp.close(),
  }
}
