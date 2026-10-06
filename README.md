# Kervan

Kervan is a TypeScript framework for [Model Context Protocol](https://modelcontextprotocol.io)
servers. It is a thin layer over the official SDK (`@modelcontextprotocol/server` v2): you define
tools, and Kervan handles validation, error masking, timeouts, transports and change
notifications. Tools can also be declared in a `kervan.yaml` file, without code.

> **Status: 0.1, pre-release.** The API is listed in [docs/API.md](docs/API.md) with its
> stability; experimental parts may change in any release.

## Quick start

```sh
npm create kervan@latest my-server
cd my-server
npm run dev      # hot reload, plus a REPL in the terminal
npm test
```

A tool in code:

```ts
import { createApp, ToolError, z } from "@kervan/core"
import { serve } from "@kervan/transport/node"

const app = createApp({ name: "weather", version: "0.1.0" })

app.tool("get_weather", {
  description: "Current temperature (°C) at a coordinate.",
  input: z.object({ latitude: z.number(), longitude: z.number() }),
  output: z.object({ temperatureC: z.number() }),
  annotations: { readOnlyHint: true },
  handler: async ({ latitude, longitude }, ctx) => {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m`
    const response = await fetch(url, { signal: ctx.signal })
    if (!response.ok) throw new ToolError("The weather service is unavailable; try again later.")
    const data = await response.json()
    return { temperatureC: data.current.temperature_2m }
  },
})

await serve(app) // stdio by default; --http for Streamable HTTP on 127.0.0.1:3000
```

The same tool as a spec, served with `npx kervan run kervan.yaml`:

```yaml
specVersion: 1
name: weather
version: 0.1.0
tools:
  - name: get_weather
    description: Current temperature (°C) at a coordinate.
    annotations: { readOnlyHint: true }
    input:
      type: object
      properties: { latitude: { type: number }, longitude: { type: number } }
      required: [latitude, longitude]
    http:
      url: https://api.open-meteo.com/v1/forecast
      query: { latitude: "{{input.latitude}}", longitude: "{{input.longitude}}", current: temperature_2m }
    output:
      select: "{temperatureC: current.temperature_2m}"
```

Connect either one to an MCP client, for example Claude Code:

```sh
claude mcp add weather -- npx kervan run /absolute/path/to/kervan.yaml
```

## Packages

| Package | |
| --- | --- |
| [`@kervan/core`](packages/core) | `createApp`, tools, the tool context (`ctx.signal`, `ctx.progress`, `ctx.log`, `ctx.auth`), middleware, the tool registry. No transport, database or UI code. |
| [`@kervan/transport`](packages/transport) | stdio and Streamable HTTP on Node, a fetch handler for Workers/Deno/Bun, multi-tenant `resolveServer`, and `createTestClient`. |
| [`@kervan/spec-runtime`](packages/spec-runtime) | `kervan.yaml` specs: HTTP tools with templates, JMESPath output selection, SSRF protection and secret redaction. |
| [`kervan`](packages/cli) | The CLI: `kervan create`, `kervan dev` (hot reload, REPL), `kervan run`. |
| [`create-kervan`](packages/create-kervan) | `npm create kervan`. |

Examples: [`weather`](examples/weather) (code), [`spec`](examples/spec) (`kervan.yaml`),
[`dynamic`](examples/dynamic) (runtime changes and multi-tenancy).

## What Kervan does for you

- **Validation and typing.** Zod (or JSON Schema) input and output schemas; invalid arguments come
  back to the model as a tool error it can fix, and never reach your handler.
- **Error masking.** Only `ToolError` messages reach the client. Anything else becomes
  `Internal error in tool "x" (ref: 1a2b3c4d)`, with the real error in your logs under the same ref.
- **Tools that change at runtime.** `app.tool()`, `app.replaceTool()` and `app.removeTool()` while the
  server runs; clients get `list_changed` only when the tool list really changed. Bring your own
  registry (database, config service) through a two-method interface.
- **Multi-tenant HTTP.** `resolveServer` picks a tenant's tool set after authentication, with
  per-tenant notification isolation.
- **Middleware** around every tool call, for logging, policy checks or metrics.
- **Development loop.** `kervan dev` restarts your server on save without dropping the client
  connection, lets running calls finish, and has a terminal REPL.
- **Specs.** `kervan.yaml` turns HTTP APIs into tools with the same guarantees, and an editor schema
  for autocompletion.

## Security

Defaults are on: tool timeouts (30 s), argument and body size limits, `Host`/`Origin` validation
against DNS rebinding, `127.0.0.1` binding, an HTTP rate limit, logs on stderr only. Spec tools
add SSRF protection (public addresses only, DNS pinned, redirects re-checked, this machine's own
addresses refused), context-aware template escaping, secret redaction in every result, error and
log line, response size and type limits, and per-tool rate limits.

The security model, its known limits, and how to report a vulnerability are in
[SECURITY.md](SECURITY.md).

## Compatibility

| | |
| --- | --- |
| Node.js | 22 or newer for the libraries; 22.18+ (or 23.6+) for the CLI and generated projects, which run TypeScript directly. On Windows with Node 24, use 24.21 or newer (24.15 has a libuv crash). |
| MCP | 2026-07-28 (stateless) and the 2025 revisions up to 2025-11-25, from the same server. Over HTTP, 2025-era clients are served statelessly and receive `list_changed` only on their next `tools/list`. |
| Runtimes | Node for everything; the fetch handler also runs on Workers, Deno and Bun. Spec tools need Node. |

## How Kervan compares

As of October 2026 there are several good TypeScript MCP frameworks (for example xmcp, mcp-use,
FastMCP for TypeScript and mcp-framework), and edge support is common among them. Kervan focuses
on tool sets that change at runtime, multi-tenant serving, and declarative specs with security
built in. We are not aware of another TypeScript framework built around specs this way, but the
ecosystem moves quickly.

## Roadmap

1. Core and transports.
2. Runtime registry, `resolveServer`, middleware, `kervan create` and `kervan dev`.
3. Specs and `kervan run`.
4. **Next:** Kervan Studio, an optional web UI that builds specs on top of the framework. The
   framework will never depend on it.

## Development

Requires Node 22.18+ and pnpm.

```sh
pnpm install
pnpm build        # tsc -b
pnpm test         # build, then Vitest
pnpm lint         # Biome
pnpm typecheck    # sources and tests
pnpm check:pack   # publint + are-the-types-wrong
```

`prepublishOnly` blocks publishing unless `KERVAN_ALLOW_PUBLISH=1` is set.

## License

[MIT](LICENSE)
