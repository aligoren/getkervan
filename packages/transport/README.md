# @kervan/transport

Serve a [`@kervan/core`](../core) app over stdio or Streamable HTTP. Both MCP 2026-07-28 clients and
2025-era clients (up to `2025-11-25`) are served from the same app.

## Node: `@kervan/transport/node`

```ts
import { serve, serveHttp, serveStdio } from "@kervan/transport/node"

await serve(app) // --http / --stdio flag, else KERVAN_TRANSPORT, else stdio; closes on SIGINT/SIGTERM

serveStdio(app)
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

The handler is stateless: a fresh SDK server handles each request, and no sessions are created.
2025-era session operations (`GET`, `DELETE`) get `405`.

## Testing: `@kervan/transport/testing`

```ts
import { createTestClient } from "@kervan/transport/testing"

const client = await createTestClient(app) // era: "modern" (default) or "legacy"
await client.callTool({ name: "add", arguments: { a: 1, b: 2 } })
await client.close()
```

This needs `@modelcontextprotocol/client` as a (dev) dependency. Pass `authInfo` to test tools
that read `ctx.auth`.
