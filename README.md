# Kervan

Kervan is a small TypeScript framework for writing [Model Context Protocol](https://modelcontextprotocol.io)
servers. It is a thin layer over the official SDK (`@modelcontextprotocol/server` v2): you define tools
with Zod schemas, and Kervan handles validation, error mapping, timeouts and transports (stdio,
Streamable HTTP on Node, and fetch runtimes such as Cloudflare Workers, Deno and Bun).

> **Status:** 0.1, pre-release. The packages are not published to npm yet.

```sh
npm create kervan@latest my-server   # once published
cd my-server && npm run dev
```

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
| [`@kervan/spec-runtime`](packages/spec-runtime) | `kervan.yaml` specs: HTTP API tools with templates, JMESPath output selection, SSRF protection and secret redaction. |
| [`kervan`](packages/cli) | The CLI: `kervan create` (and `npm create kervan`) and `kervan dev` (hot reload, terminal REPL). Generated projects run TypeScript directly on Node.js 22.18+. |
| [`examples/weather`](examples/weather) | A runnable example server with tests. |
| [`examples/spec`](examples/spec) | A `kervan.yaml` spec backed by Open-Meteo. |
| [`examples/dynamic`](examples/dynamic) | Tools that change at runtime, and a multi-tenant HTTP server. |

## Tools

- `input` is a `z.object(...)`. Invalid arguments never reach your handler; the client gets a tool
  error (`isError: true`) it can read and retry from.
- Without `output`, return a string or a full `CallToolResult`. With `output`, return the typed
  value: Kervan sends it as `structuredContent` plus a JSON text block.
- `description` is required. Tool names follow the MCP rule: 1-128 characters from `A-Z a-z 0-9 _ - .`.
- Definition mistakes (bad name, duplicate tool, non-object input, ...) throw `KervanDefinitionError`
  at startup with a code and a hint.

### Middleware

`app.use((call, next) => ...)` wraps every tool call (logging, policy checks, metrics); a tool can
add its own with `middleware: [...]`. See [`@kervan/core`](packages/core#middleware).

### Errors

| Handler does | Client sees |
| --- | --- |
| `throw new ToolError("...")` | the message, as a tool error |
| throws anything else | `Internal error in tool "x" (ref: 1a2b3c4d)`; the real error is logged to stderr with the same ref |
| exceeds its timeout | `Tool "x" timed out after N ms.`, and `ctx.signal` aborts |

Unexpected error messages are never sent to the client, so connection strings, tokens or stack
traces cannot leak into the model's context.

## Changing tools at runtime

Tools live in a registry (`app.registry`, an `InMemoryToolRegistry` by default) and can change
while the server runs:

```ts
app.tool("report", { description: "...", handler: () => "v1" })
app.replaceTool("report", { description: "...", handler: () => "v2" }) // keeps its position
app.removeTool("report")
```

Connected clients are told with `notifications/tools/list_changed`:

| Connection | How the change reaches the client |
| --- | --- |
| stdio, any protocol era | pushed on the connection |
| HTTP, 2026-07-28 clients | pushed on the client's `subscriptions/listen` stream |
| HTTP, 2025-era clients | **not pushed**: legacy HTTP is served statelessly, so there is no stream to push on. The client sees the new list on its next `tools/list`. |

Several changes made in the same tick produce one notification, and the list order is always the
registry order (`replaceTool` keeps a tool's position, new tools go last).

### Bring your own registry

Transports only need the read side, `ToolRegistry`: `list()` and `onChange(listener)`. You can back
it with a database, a config service or anything else; Kervan's core contains no such
implementation. Two rules keep notifications correct:

- **Stable identity.** `list()` must return the *same entry objects* for tools that did not change.
  Kervan compares entries by identity: a change event whose list is identical sends nothing.
- **Shared registries notify everywhere.** If several server instances share a registry, fire
  `onChange` on every instance when any of them changes it (for example through your database's
  pub/sub). Each instance then notifies its own connected clients. This is Kervan's multi-instance
  contract; there is no separate event bus to configure.

### Multi-tenant servers: `resolveServer`

```ts
await serveHttp(app, {
  authenticate: verifyApiKey, // returns AuthInfo with the tenant in a claim, or a 401 Response
  resolveServer: (_request, { auth }) => registries.get(auth?.extra?.tenant) ?? null,
})
```

`resolveServer` runs after `authenticate` and picks the registry that serves the request.
`null`/`undefined` answers 404 and `FORBIDDEN` answers 403, both with fixed messages that never
name the tenant. If you do not want to reveal whether a tenant exists, return `null` in both cases.
Each registry gets its own SDK handler and event bus, so one tenant's changes never notify another
tenant's clients.

> **Security.** Derive the tenant from the *verified* credential (`auth`), such as a claim in a
> validated token or the account an API key belongs to. A tenant id taken only from a header,
> path or hostname the client controls is not proof of anything; use it only after checking it
> against `auth`.

Return the **same registry object** for the same tenant. Kervan keeps one handler per registry
(weakly, so it is released together with the registry); a new object per request would create a
new handler each time and break change notifications.

## Testing

```ts
import { createTestClient } from "@kervan/transport/testing"

const client = await createTestClient(app) // official SDK Client, no port, no process
const result = await client.callTool({ name: "get_weather", arguments: { city: "Istanbul" } })
```

`createTestClient(app, { era: "legacy" })` speaks the 2025 handshake instead. Both eras receive
`list_changed`, so you can test runtime changes too (pass `client: { listChanged: ... }`).

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

- **Runtime tool registry**: add, replace and remove tools while the server runs, with
  `list_changed` sent automatically on stdio and HTTP, and a small interface for your own storage.
- **Per-request server resolution**: a `resolveServer` hook for multi-tenant servers, with
  per-tenant notification isolation and the tenant logic living outside the core.
- **Declarative specs**: a `kervan.yaml` file that turns HTTP APIs into tools, with SSRF
  protection, secret redaction and output selection built in. Every feature of the spec format is
  also available in the code API (`httpTool`). We are not aware of another TypeScript framework
  built around this, but the ecosystem moves quickly.
- **An optional Studio UI** (later) that builds on the framework. The framework will never depend
  on it.

## Roadmap

1. **Core and transports**: `app.tool`, validation, stdio and Streamable HTTP, a test client.
2. **Dynamic tools and tooling**: runtime registry, `resolveServer`, middleware, `kervan create` and
   `kervan dev`.
3. **Specs**: `kervan.yaml`, HTTP executor with SSRF protection, secrets, output selection, `kervan run`.
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

**Windows and Node 24.** With Node 24.15.0 (libuv 1.51.0) on Windows, the HTTP test file
occasionally crashed its Vitest worker with exit code `3221226505` (a libuv
`UV_HANDLE_CLOSING` assertion around `fetch`). We saw it in 4 of 70 runs on 24.15.0 and in none of
60 runs on Node 24.21.0 (libuv 1.52.1) or 30 runs on Node 22. On Windows, if you use Node 24,
use 24.21 or newer.

## License

MIT
