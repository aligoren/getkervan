import http from "node:http"
import { createApp, type Logger, silentLogger, ToolError, z } from "@kervan/core"

export const MODERN = "2026-07-28"

/** A small app exercising the features the transport tests need. */
export function demoApp(options: { logger?: Logger; protocolLogging?: boolean } = {}) {
  const app = createApp({
    name: "demo",
    version: "1.2.3",
    logger: options.logger ?? silentLogger,
    protocolLogging: options.protocolLogging ?? false,
  })
  app.tool("zeta", { description: "Registered first", handler: () => "z" })
  app.tool("add", {
    title: "Add",
    description: "Adds two numbers",
    input: z.object({ a: z.number(), b: z.number() }),
    output: z.object({ sum: z.number() }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    handler: ({ a, b }, ctx) => {
      ctx.log.info("adding", { a, b })
      return { sum: a + b }
    },
  })
  app.tool("alpha", {
    description: "Registered last",
    input: z.object({ fail: z.boolean().optional() }),
    handler: ({ fail }) => {
      if (fail) throw new ToolError("alpha failed on purpose")
      return "a"
    },
  })
  app.tool("whoami", {
    description: "Echoes the authenticated client id",
    handler: (_input, ctx) => ctx.auth?.clientId ?? "anonymous",
  })
  return app
}

export interface RawResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: string
}

/** Sends a request with full control over headers (including Host), which `fetch` does not allow. */
export function rawRequest(
  url: URL,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method: options.method ?? "POST",
        headers: {
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          accept: "application/json, text/event-stream",
          ...options.headers,
        },
      },
      (res) => {
        let body = ""
        res.setEncoding("utf8")
        res.on("data", (chunk: string) => {
          body += chunk
        })
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      },
    )
    req.on("error", reject)
    if (options.body !== undefined) {
      req.write(typeof options.body === "string" ? options.body : JSON.stringify(options.body))
    }
    req.end()
  })
}

let nextId = 1

/** Builds a 2026-07-28 request: envelope `_meta` plus the matching routing headers. */
export function modernRequest(
  method: string,
  params: Record<string, unknown> = {},
  options: { meta?: Record<string, unknown>; headers?: Record<string, string> } = {},
) {
  const name = typeof params.name === "string" ? params.name : undefined
  return {
    headers: {
      "mcp-protocol-version": MODERN,
      "mcp-method": method,
      ...(name === undefined ? {} : { "mcp-name": name }),
      ...options.headers,
    },
    body: {
      jsonrpc: "2.0",
      id: nextId++,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientCapabilities": {},
          ...options.meta,
        },
      },
    },
  }
}

/** Parses a JSON or SSE response body into its JSON-RPC messages. */
export function messagesOf(response: RawResponse): Record<string, unknown>[] {
  if (String(response.headers["content-type"]).startsWith("text/event-stream")) {
    return response.body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)))
  }
  return [JSON.parse(response.body)]
}
