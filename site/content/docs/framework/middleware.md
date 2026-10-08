---
title: Middleware
seoTitle: Kervan middleware for MCP tool calls
description: Run code around every Kervan MCP tool call or around one tool's calls; logging, timing, permission checks and result changes, inside the call's timeout.
lead: Middleware wraps tool calls. App middleware runs for every tool, a tool's own middleware only for that tool.
weight: 54
group: Build with TypeScript
fits: 'Build with TypeScript. Middleware runs inside each call, between argument validation and your [handler](/docs/framework/code/); [errors](/docs/framework/errors/) are mapped after it.'
next:
  - url: /docs/framework/registry/
    text: A registry that changes at runtime
  - url: /docs/framework/transports/#authentication
    text: Authentication
    note: where `ctx.auth` comes from
  - url: /docs/framework/api/
    text: Programmatic API
    note: "`ToolMiddleware`, `ToolCall`"
---

## Around every call, or one tool's

```ts {check="ts-run" expect="This tool needs the admin scope."}
import { createApp, type ToolMiddleware, ToolError, z } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"

const app = createApp({ name: "middleware", version: "0.1.0" })

// For every tool: how long each call took, in the server's log.
app.use(async (call, next) => {
  const started = Date.now()
  try {
    return await next()
  } finally {
    app.logger.info(`${call.tool.name} took ${Date.now() - started} ms`)
  }
})

// For one tool: refuse callers without the admin scope (ctx.auth comes from authenticate).
const requireAdmin: ToolMiddleware = async (call, next) => {
  if (!call.ctx.auth?.scopes.includes("admin")) throw new ToolError("This tool needs the admin scope.")
  return next()
}

app.tool("reset_counter", {
  description: "Resets the counter.",
  input: z.object({ to: z.number().int().default(0) }),
  middleware: [requireAdmin],
  handler: ({ to }) => `counter is ${to}`,
})

const client = await createTestClient(app)
const result = await client.callTool({ name: "reset_counter", arguments: {} })
console.log((result.content as { text: string }[])[0]?.text)
await client.close()
```

The test client has no `authInfo`, so the admin check refuses the call; the timing middleware
still logs it (`[kervan] info: reset_counter took 0 ms` on stderr). To test a caller with scopes,
pass `authInfo` to `createTestClient` ([testing](/docs/framework/testing/)).

## The rules

{{% include file="packages/core/README.md" section="Middleware" fromLine="- Order:" %}}
