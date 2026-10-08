# @kervan/core

> **Not published yet.** This package is not on npm yet; the install and `npx` commands below
> work once it is. Until then, build Kervan from source (see the repository README,
> "Development").

Define MCP tools with Zod schemas. `@kervan/core` builds the official SDK server and contains no
transport, database or UI code. Pair it with [`@kervan/transport`](../transport) to serve it.

```ts
import { createApp, z } from "@kervan/core"

const app = createApp({ name: "my-server", version: "0.1.0" })

app.tool("add", {
  description: "Adds two numbers",
  input: z.object({ a: z.number(), b: z.number() }),
  output: z.object({ sum: z.number() }),
  annotations: { readOnlyHint: true },
  handler: ({ a, b }) => ({ sum: a + b }),
})
```

## `createApp(options)`

| Option | Default | Description |
| --- | --- | --- |
| `name`, `version` | required | Server identity sent to clients |
| `title`, `instructions` | | Display name and server-level guidance |
| `logger` | `console.error` at `info` | Any `{ debug, info, warn, error }`; must not write to stdout |
| `protocolLogging` | `false` | Also forward `ctx.log` to the client (only when the request `_meta` has a `logLevel`) |
| `listCache` | `ttlMs: 0`, `private` | Cache hint for `tools/list` (protocol 2026-07-28) |
| `limits.toolTimeoutMs` | `30000` | Default per-call timeout |
| `limits.maxToolInputElements` | `10000` | Maximum array elements plus object members in one call's arguments |

## `app.tool(name, definition)`

| Field | Description |
| --- | --- |
| `description` | Required. The model's main guidance. |
| `input` | `z.object(...)`; omit for a tool without arguments |
| `output` | Zod schema; when set, the handler returns that type and Kervan builds `structuredContent` |
| `title`, `annotations` | Display name and behavior hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) |
| `timeoutMs` | Overrides `limits.toolTimeoutMs` |
| `handler(input, ctx)` | Returns a string, a `CallToolResult`, or the `output` value |

## JSON Schema and raw results (experimental)

> `jsonSchema()` and `rawResult()` are **experimental**: their behavior may change before 1.0.

- `input` and `output` also accept `jsonSchema({...})`, for schemas that come from data (another
  server, a spec file) rather than code. Arguments are validated against it; `input` must be an
  object schema.
- A tool with an `output` schema can return `rawResult(callToolResult)` to send a complete result
  unchanged (`kervan dev` uses it to forward results). It **skips Kervan's normalization**: no
  JSON text block is added and `structuredContent` is not built for you. The SDK still validates
  `structuredContent` against the output schema for non-error results, so a missing or invalid
  one becomes an "Output validation error".

## Registry

| API | Description |
| --- | --- |
| `app.registry` | The app's `MutableToolRegistry` (default `InMemoryToolRegistry`; pass `createApp({ registry })` to use another) |
| `app.tool` / `app.replaceTool` / `app.removeTool` | Change the tool set at runtime; connected clients get `list_changed` |
| `ToolRegistry` | The read side transports use: `list()` and `onChange(listener)` |
| `app.createServer(registry?)` | A fresh SDK server from a snapshot (per HTTP request) |
| `app.createLiveServer(registry?)` | An SDK server that follows the registry (per stdio or in-memory connection) |
| `ServerResolver`, `FORBIDDEN` | Types for the transport's `resolveServer` hook |

Custom registries must return the **same entry objects** for unchanged tools: Kervan compares by
identity to avoid spurious notifications. Registries shared by several instances should fire
`onChange` on every instance. `InMemoryToolRegistry` coalesces changes made in one tick into a
single `onChange` call.

## Middleware

```ts {check="ts-syntax"}
app.use(async (call, next) => {
  const started = Date.now()
  try {
    return await next()
  } finally {
    app.logger.info(`${call.tool.name} took ${Date.now() - started} ms`)
  }
})

app.tool("drop_table", { description: "...", middleware: [requireAdmin], handler })
```

- Order: app middleware in `app.use` order, then the tool's `middleware`, then the handler.
  Results unwind in reverse.
- A middleware sees the validated `call.input`, `call.tool` (name, title, description,
  annotations) and `call.ctx`. It can return a result without calling `next()` (short-circuit) or
  change the result `next()` returns.
- Errors travel through the chain as exceptions and are mapped once, at the outside: `ToolError`
  messages reach the client, anything else is masked. Timeouts and cancellation cover the whole
  chain. Calling `next()` twice is an error.
- `app.use` applies immediately, also to connected clients and to tools served from other
  registries (`resolveServer`). Filtering which tools a caller *sees* is `resolveServer`'s job,
  not middleware's. For HTTP-level middleware, use `handler.hono`.

## Tool context

| Member | Description |
| --- | --- |
| `ctx.signal` | Aborts on client cancellation or timeout. Pass it to `fetch` and other I/O. |
| `ctx.progress(value, total?, message?)` | Sends progress if the client asked for it. Values must increase. |
| `ctx.log.debug/info/warning/error(message, data?)` | Server logger (stderr) |
| `ctx.auth` | `AuthInfo` from the HTTP layer, if any |
| `ctx.requestId`, `ctx.toolName` | |
| `ctx.raw` | The SDK context, for anything Kervan does not wrap yet |

## Errors

Throw `ToolError` for failures the model should read. Any other error is logged with a reference id,
and the client gets only `Internal error in tool "x" (ref: ...)`. Invalid definitions throw
`KervanDefinitionError` with a `code` such as `INVALID_TOOL_NAME` or `DUPLICATE_TOOL`.

`z` is re-exported from `zod` (v4).
