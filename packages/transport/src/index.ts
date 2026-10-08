import { type App, FORBIDDEN, type ServerResolver, type ToolRegistry } from "@kervan/core"
import { createMcpHonoApp } from "@modelcontextprotocol/hono"
import type {
  AuthInfo,
  CreateMcpHandlerOptions,
  McpHttpHandler,
} from "@modelcontextprotocol/server"
import type { Context, Hono } from "hono"
import { RegistryHandlers } from "./registry-handler.js"

export type { AuthInfo } from "@modelcontextprotocol/server"

/**
 * Verifies the caller. Return `AuthInfo` to accept, a `Response` (e.g. a 401 with a
 * `WWW-Authenticate` challenge) to reject, or `undefined` to continue unauthenticated.
 * `context.params` holds the MCP route's parameters (see `path`).
 */
export type Authenticate = (
  request: Request,
  context: { params: Readonly<Record<string, string>> },
) => AuthInfo | Response | undefined | Promise<AuthInfo | Response | undefined>

export interface FetchHandlerOptions {
  /**
   * Route that serves MCP. Default: `"/mcp"`. May have parameters, e.g. `"/s/:serverId/mcp"`;
   * `authenticate` and `resolveServer` receive them as `params`.
   */
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
  /**
   * Refuse JSON-RPC batches (a JSON array body) with a 400. Batching exists only in protocol
   * 2025-03-26; one batched request can carry many tool calls, so per-request limits (rate
   * limits, `authenticate` quotas) undercount it. Default: false.
   */
  rejectBatches?: boolean
  authenticate?: Authenticate
  /**
   * Picks the tool registry for each request, after `authenticate`. Default: the app's registry.
   * Derive the tenant from the verified `auth`, and return the same registry object for the same
   * tenant. `null`/`undefined` → 404, `FORBIDDEN` → 403; both with fixed messages.
   */
  resolveServer?: ServerResolver
}

export interface KervanHttpHandler {
  /** A Fetch API handler (`Request` in, `Response` out), the shape fetch runtimes expect. Tested on Node. */
  fetch: (request: Request, env?: unknown, executionCtx?: unknown) => Response | Promise<Response>
  /** The underlying Hono app, for mounting extra routes or middleware. */
  hono: Hono
  /** The SDK handler serving the app's own registry. */
  readonly mcp: McpHttpHandler
  /** The SDK handler serving `registry` (created on first use). */
  handlerFor(registry: ToolRegistry): McpHttpHandler
  /** Aborts in-flight requests and open subscription streams of every registry. */
  close(): Promise<void>
}

/**
 * Serves an app over Streamable HTTP as a web-standard fetch handler. Validates `Host`/`Origin`,
 * bounds the body size and serves both protocol eras statelessly; a fresh SDK server handles each
 * request.
 */
export function toFetchHandler(app: App, options: FetchHandlerOptions = {}): KervanHttpHandler {
  const path = options.path ?? "/mcp"
  const handlers = new RegistryHandlers(app, {
    ...(options.legacy === undefined ? {} : { legacy: options.legacy }),
    ...(options.responseMode === undefined ? {} : { responseMode: options.responseMode }),
    ...(options.maxRequestBodySize === undefined
      ? {}
      : { maxRequestBodySize: options.maxRequestBodySize }),
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
    if (options.rejectBatches && Array.isArray(parsedBody)) {
      return jsonRpcError(c, 400, "Batch requests are not supported", -32600)
    }
    const params: Readonly<Record<string, string>> = Object.freeze({ ...c.req.param() })
    let authInfo: AuthInfo | undefined
    if (options.authenticate) {
      const outcome = await options.authenticate(c.req.raw, { params })
      if (outcome instanceof Response) return outcome
      authInfo = outcome
    }

    let registry: ToolRegistry = app.registry
    if (options.resolveServer) {
      // Runs after authentication. Error bodies are fixed strings: they never echo the tenant.
      const resolved = await options.resolveServer(c.req.raw, { auth: authInfo, params })
      if (resolved === FORBIDDEN) return jsonRpcError(c, 403, "Forbidden")
      if (resolved === null || resolved === undefined) return jsonRpcError(c, 404, "Not found")
      if (!isToolRegistry(resolved)) {
        throw new TypeError(
          "resolveServer must return a ToolRegistry, FORBIDDEN, null or undefined",
        )
      }
      registry = resolved
    }

    return handlers.get(registry).fetch(c.req.raw, {
      ...(parsedBody === undefined ? {} : { parsedBody }),
      ...(authInfo === undefined ? {} : { authInfo }),
    })
  })

  hono.onError((error, c) => {
    const ref = crypto.randomUUID().slice(0, 8)
    app.logger.error(`HTTP request failed (ref: ${ref})`, error)
    return jsonRpcError(c, 500, `Internal error (ref: ${ref})`, -32603)
  })

  return {
    fetch: (request, env, executionCtx) =>
      hono.fetch(request, env, executionCtx as Parameters<Hono["fetch"]>[2]),
    hono,
    get mcp() {
      return handlers.get(app.registry)
    },
    handlerFor: (registry) => handlers.get(registry),
    close: () => handlers.closeAll(),
  }
}

function jsonRpcError(c: Context, status: 400 | 403 | 404 | 500, message: string, code = -32000) {
  return c.json({ jsonrpc: "2.0", error: { code, message }, id: null }, status)
}

function isToolRegistry(value: unknown): value is ToolRegistry {
  const candidate = value as Partial<ToolRegistry> | null
  return typeof candidate?.list === "function" && typeof candidate.onChange === "function"
}
