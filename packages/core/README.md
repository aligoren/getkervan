# @kervan/core

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

| Option | Default | |
| --- | --- | --- |
| `name`, `version` | required | Server identity sent to clients |
| `title`, `instructions` | | Display name and server-level guidance |
| `logger` | `console.error` at `info` | Any `{ debug, info, warn, error }`; must not write to stdout |
| `protocolLogging` | `false` | Also forward `ctx.log` to the client (only when the request `_meta` has a `logLevel`) |
| `listCache` | `ttlMs: 0`, `private` | Cache hint for `tools/list` (protocol 2026-07-28) |
| `limits.toolTimeoutMs` | `30000` | Default per-call timeout |
| `limits.maxToolInputElements` | `10000` | Maximum array elements plus object members in one call's arguments |

## `app.tool(name, definition)`

| Field | |
| --- | --- |
| `description` | Required. The model's main guidance. |
| `input` | `z.object(...)`; omit for a tool without arguments |
| `output` | Zod schema; when set, the handler returns that type and Kervan builds `structuredContent` |
| `title`, `annotations` | Display name and behavior hints (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) |
| `timeoutMs` | Overrides `limits.toolTimeoutMs` |
| `handler(input, ctx)` | Returns a string, a `CallToolResult`, or the `output` value |

## Tool context

| | |
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
