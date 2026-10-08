---
title: Errors
seoTitle: 'Kervan tool errors: ToolError and masking'
description: How a Kervan MCP tool reports failures; ToolError messages reach the model, every other error is logged with a reference and masked from the client.
lead: Two kinds of failure, and who sees what. A message meant for the model is a `ToolError`; anything else stays on the server.
weight: 52
group: Build with TypeScript
fits: 'Build with TypeScript. After [tools in TypeScript](/docs/framework/code/); errors pass through [middleware](/docs/framework/middleware/) before they are mapped.'
next:
  - url: /docs/framework/middleware/
    text: Middleware
    note: what runs around every call
  - url: /docs/framework/testing/
    text: Testing
  - url: /docs/framework/api/
    text: Programmatic API
    note: "`ToolError`, `KervanDefinitionError`"
---

## Who sees what

{{% include file="packages/core/README.md" section="Errors" %}}

The tool's result has `isError: true` in both cases, so the client and the model know the call
failed. Arguments that do not fit the input schema are refused the same way, before the handler
runs.

## Both kinds in one program

```ts {check="ts-run" expect="Internal error in tool"}
import { createApp, ToolError, z } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"

const app = createApp({ name: "errors", version: "0.1.0" })

app.tool("divide", {
  description: "Divides a by b.",
  input: z.object({ a: z.number(), b: z.number() }),
  handler: ({ a, b }) => {
    // A failure the model should read: the message reaches the client.
    if (b === 0) throw new ToolError("b must not be zero.")
    return String(a / b)
  },
})

app.tool("lookup", {
  description: "Fails the way a bug or an outage does.",
  handler: () => {
    // Anything else is logged on the server with a reference; the client sees only the reference.
    throw new Error("connection refused by 10.0.0.12:5432")
  },
})

const client = await createTestClient(app)
const text = (result: { content: unknown }) => (result.content as { text: string }[])[0]?.text
console.log(text(await client.callTool({ name: "divide", arguments: { a: 1, b: 0 } })))
console.log(text(await client.callTool({ name: "lookup", arguments: {} })))
await client.close()
```

It prints the `ToolError` message, then only the reference for the other failure. The server's
log (stderr) has the full error with the same reference, so the two can be matched:

```text
b must not be zero.
[kervan] error: Tool "lookup" failed (ref: 936369d9) Error: connection refused by 10.0.0.12:5432
Internal error in tool "lookup" (ref: 936369d9).
```

Write `ToolError` messages for the model: what went wrong and what it could do differently.
Never put a secret or an internal detail in one; it is sent as written.
