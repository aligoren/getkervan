---
title: Tools in TypeScript
seoTitle: Write MCP tools in TypeScript with Kervan and Zod
description: Write MCP tools in TypeScript with @kervan/core, Zod input and output schemas, the tool context, ToolError, middleware and a registry that changes at runtime.
lead: When a tool needs logic, write it in TypeScript. `@kervan/core` builds the official SDK server; you write the handler.
weight: 70
---

## A complete server

This program defines a tool, then calls it the way a client would, through `createTestClient`
(in-memory, no network). Save it as `src/add.ts` in a project made by `kervan create` (or
`pnpm try:new`) and run it with `node src/add.ts`:

```ts {check="ts-run" expect="sum: 5"}
import { createApp, ToolError, z } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"

const app = createApp({ name: "calculator", version: "0.1.0" })

app.tool("add", {
  description: "Adds two numbers.",
  input: z.object({ a: z.number(), b: z.number() }),
  output: z.object({ sum: z.number() }),
  annotations: { readOnlyHint: true },
  handler: ({ a, b }) => {
    if (!Number.isFinite(a + b)) throw new ToolError("The sum is too large.")
    return { sum: a + b }
  },
})

const client = await createTestClient(app)
const result = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } })
console.log(`sum: ${(result.structuredContent as { sum: number }).sum}`)
await client.close()
```

To serve it instead, replace the last four lines with `await serve(app)` from
`@kervan/transport/node` (see [transports](/docs/framework/transports/)).

{{% include file="packages/core/README.md" section="`createApp(options)`" %}}

## Defining a tool

{{% include file="packages/core/README.md" section="`app.tool(name, definition)`" %}}

## The tool context

{{% include file="packages/core/README.md" section="Tool context" %}}

## Errors

{{% include file="packages/core/README.md" section="Errors" %}}

## Middleware

{{% include file="packages/core/README.md" section="Middleware" %}}

## A registry that changes at runtime

{{% include file="packages/core/README.md" section="Registry" %}}

## JSON Schema and raw results (experimental)

{{% include file="packages/core/README.md" section="JSON Schema and raw results (experimental)" %}}

## A spec tool in code

Every `kervan.yaml` tool compiles to an ordinary tool definition. To mix both in one server,
load a spec into the app's registry:

```ts {check="ts"}
import { readFile } from "node:fs/promises"
import { createApp } from "@kervan/core"
import { applySpec, loadSpec } from "@kervan/spec-runtime"

const app = createApp({ name: "weather", version: "0.1.0" })
applySpec(app.registry, await loadSpec(await readFile("kervan.yaml", "utf8")))
```
