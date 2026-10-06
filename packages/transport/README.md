# @kervan/transport

Serve a [`@kervan/core`](../core) app over stdio or Streamable HTTP. Both MCP 2026-07-28 clients and
2025-era clients (up to `2025-11-25`) are served from the same app.

## Node: `@kervan/transport/node`

```ts
import { serve, serveHttp, serveStdio } from "@kervan/transport/node"

await serve(app) // --http / --stdio flag, else KERVAN_TRANSPORT, else stdio; closes on SIGINT/SIGTERM

serveStdio(app) // options: { registry, legacy }
const server = await serveHttp(app, { port: 3000 }) // server.url, server.close()
```

`serveHttp` options (in addition to the fetch handler options below):

| Option | Default | |
| --- | --- | --- |
| `port` | `3000` | `0` picks a free port. `serve` also reads `--port=` and `PORT`. |
| `host` | `"127.0.0.1"` | Interface to bind. `serve` also reads `--host=` and `HOST`. |
| `rateLimit` | `{ windowMs: 60000, max: 300 }` | Per client, in memory, `429` with `Retry-After`. `false` disables it. |
| `rateLimit.keyGenerator` | socket address | `X-Forwarded-For` is **not** trusted. Behind a proxy, derive the key yourself. |

The rate limiter only exists in `serveHttp`. With `toFetchHandler` (Workers, Deno, Bun), use your
platform's rate limiting.

## Fetch runtimes: `@kervan/transport`

```ts
import { toFetchHandler } from "@kervan/transport"

export default toFetchHandler(app, { allowedHosts: ["mcp.example.com"] })
```

| Option | Default | |
| --- | --- | --- |
| `path` | `"/mcp"` | |
| `allowedHosts` | localhost only | Accepted `Host` header names (DNS rebinding protection, `403` otherwise) |
| `allowedOrigins` | localhost only | Accepted `Origin` names; requests without `Origin` pass |
| `maxRequestBodySize` | 4 MiB | `413` above it |
| `responseMode` | `"auto"` | `"json"` drops mid-call notifications; `"sse"` always streams |
| `legacy` | `"stateless"` | `"reject"` serves 2026-07-28 clients only |
| `authenticate(request)` | | Return `AuthInfo` (reaches tools as `ctx.auth`), a `Response` to reject, or `undefined` |
| `resolveServer(request, { auth })` | app's registry | Runs after `authenticate`. Return a `ToolRegistry`, `null` (404) or `FORBIDDEN` (403). Derive the tenant from the verified `auth`; return the same registry object for the same tenant. |

The handler is stateless: a fresh SDK server handles each request, and no sessions are created.
2025-era session operations (`GET`, `DELETE`) get `405`.

Each registry gets its own SDK handler (`handler.handlerFor(registry)`), so change notifications
stay within a tenant. Registry changes are pushed to 2026-07-28 clients on their
`subscriptions/listen` stream. 2025-era HTTP clients cannot be pushed to (there is no stream in
stateless legacy serving); they see changes on their next `tools/list`. On stdio, both eras get
pushed notifications.

## Testing: `@kervan/transport/testing`

```ts
import { createTestClient } from "@kervan/transport/testing"

const client = await createTestClient(app) // era: "modern" (default) or "legacy"
await client.callTool({ name: "add", arguments: { a: 1, b: 2 } })
await client.close()
```

This needs `@modelcontextprotocol/client` as a (dev) dependency. Pass `authInfo` to test tools
that read `ctx.auth`, `registry` to serve another tool set, and `client` for SDK client options
such as `listChanged`. Both eras receive `list_changed`.
