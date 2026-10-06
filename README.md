# Kervan

Kervan is a small TypeScript framework for writing [Model Context Protocol](https://modelcontextprotocol.io)
servers. It is a thin layer over the official SDK (`@modelcontextprotocol/server` v2): you define tools
with Zod schemas, and Kervan handles validation, error mapping, timeouts and transports (stdio,
Streamable HTTP on Node, and fetch runtimes such as Cloudflare Workers, Deno and Bun).

> **Status:** 0.1, pre-release. The packages are not published to npm yet.

```ts
import { createApp, ToolError, z } from "@kervan/core"
import { serve } from "@kervan/transport/node"

const app = createApp({ name: "weather", version: "0.1.0" })

app.tool("get_weather", {
  description: "Current temperature for a city.",
  input: z.object({ city: z.string() }),
  output: z.object({ city: z.string(), temperatureC: z.number() }),
  annotations: { readOnlyHint: true },
  handler: async ({ city }, ctx) => {
    const data = await lookUp(city, { signal: ctx.signal })
    if (!data) throw new ToolError(`No city named "${city}".`)
    return { city, temperatureC: data.temperature }
  },
})

await serve(app) // stdio by default; `--http` for Streamable HTTP
```

## Packages

| Package | What it does |
| --- | --- |
| [`@kervan/core`](packages/core) | `createApp`, `app.tool`, the tool context (`ctx.signal`, `ctx.progress`, `ctx.log`, `ctx.auth`), error mapping. No transport, database or UI code. |
| [`@kervan/transport`](packages/transport) | `toFetchHandler` (web-standard), `serveStdio` / `serveHttp` / `serve` (Node), and `createTestClient` for tests. |
| [`examples/weather`](examples/weather) | A runnable example server with tests. |

## Tools

- `input` is a `z.object(...)`. Invalid arguments never reach your handler; the client gets a tool
  error (`isError: true`) it can read and retry from.
- Without `output`, return a string or a full `CallToolResult`. With `output`, return the typed
  value: Kervan sends it as `structuredContent` plus a JSON text block.
- `description` is required. Tool names follow the MCP rule: 1-128 characters from `A-Z a-z 0-9 _ - .`.
- Definition mistakes (bad name, duplicate tool, non-object input, ...) throw `KervanDefinitionError`
  at startup with a code and a hint.

### Errors

| Handler does | Client sees |
| --- | --- |
| `throw new ToolError("...")` | the message, as a tool error |
| throws anything else | `Internal error in tool "x" (ref: 1a2b3c4d)`; the real error is logged to stderr with the same ref |
| exceeds its timeout | `Tool "x" timed out after N ms.`, and `ctx.signal` aborts |

Unexpected error messages are never sent to the client, so connection strings, tokens or stack
traces cannot leak into the model's context.

## Testing

```ts
import { createTestClient } from "@kervan/transport/testing"

const client = await createTestClient(app) // official SDK Client, no port, no process
const result = await client.callTool({ name: "get_weather", arguments: { city: "Istanbul" } })
```

`createTestClient(app, { era: "legacy" })` speaks the 2025 handshake instead.

## Deploying

```ts
// Node, stdio or HTTP chosen by --http / --stdio / KERVAN_TRANSPORT
import { serve } from "@kervan/transport/node"
await serve(app)

// Cloudflare Workers, Deno, Bun
import { toFetchHandler } from "@kervan/transport"
export default toFetchHandler(app, { allowedHosts: ["my-server.example.com"] })
```

## Protocol support

Kervan targets MCP **2026-07-28** (the stateless revision: no `initialize`, no sessions) and, by
default, also serves clients that still speak the 2025 revisions (up to `2025-11-25`), from the
same app, on both stdio and HTTP. Every HTTP request is handled by a fresh SDK server instance, so
the HTTP endpoint scales horizontally without sticky sessions. 2025-era session operations (`GET`
streams, `DELETE`) are answered with `405`.

## Secure defaults

| Concern | Default |
| --- | --- |
| Error messages | only `ToolError` messages reach the client |
| Tool timeout | 30 s (`limits.toolTimeoutMs`, per tool `timeoutMs`) |
| Argument size | 10 000 array elements/object members (`limits.maxToolInputElements`) |
| Request body | 4 MiB (`maxRequestBodySize`) |
| DNS rebinding | `Host` and `Origin` must be localhost unless you set `allowedHosts` / `allowedOrigins` |
| Bind address | `127.0.0.1` |
| Rate limit | 300 requests/minute per socket address, **Node `serveHttp` only** |
| Logs | stderr only (stdout carries stdio JSON-RPC) |

The rate limiter keys on the TCP peer address and does not trust `X-Forwarded-For`. Behind a proxy,
pass `rateLimit.keyGenerator`. It keeps state in memory per process, and it is not applied by
`toFetchHandler`: on Workers and other fetch runtimes, use the platform's rate limiting.

**Logging.** `ctx.log.*` writes to the server logger (stderr). MCP log notifications are deprecated
as of 2026-07-28, so they are off by default. With `createApp({ protocolLogging: true })`, Kervan
also forwards them, but only for requests whose `_meta` carries `io.modelcontextprotocol/logLevel`.

**Caching.** `tools/list` results are sent with `ttlMs: 0` and `cacheScope: "private"`, so clients
never serve a stale tool list. Use `createApp({ listCache: { ttlMs, cacheScope } })` to change that.

## How Kervan compares

As of October 2026 there are several good TypeScript MCP server frameworks (for example xmcp,
mcp-use, FastMCP for TypeScript and mcp-framework), and edge/fetch support is common among them.
Kervan's focus is different:

- **Runtime tool registry** (planned for 0.2): add, replace and remove tools while the server runs,
  with `list_changed` sent automatically on stdio and HTTP.
- **Per-request server resolution** (planned for 0.2): a `resolveServer(request)` hook for
  multi-tenant servers, with the tenant logic living outside the core.
- **Declarative specs** (planned): a `kervan.yaml` file that turns HTTP APIs into tools. Every
  feature of the spec format is also available in the code API. We are not aware of another
  TypeScript framework built around this, but the ecosystem moves quickly.
- **An optional Studio UI** (later) that builds on the framework. The framework will never depend
  on it.

## Roadmap

1. **Core and transports** (this release): `app.tool`, validation, stdio and Streamable HTTP, a test
   client.
2. Dynamic registry, `resolveServer`, middleware, and a CLI (`kervan create`, `kervan dev`).
3. Spec runtime (`kervan.yaml`, HTTP executor, secrets, output mapping) and `kervan run <spec>`.
4. Kervan Studio.

## Development

Requires Node 22+ and pnpm.

```sh
pnpm install
pnpm build       # tsc -b
pnpm test        # build, then Vitest
pnpm lint        # Biome
pnpm typecheck   # sources and tests
pnpm check:pack  # publint + are-the-types-wrong
```

Publishing is blocked by a `prepublishOnly` guard until the npm scope is secured.

## License

MIT
