---
title: Testing
seoTitle: Test Kervan MCP tools with createTestClient
description: Test Kervan MCP tools in memory with createTestClient and the official SDK client, for 2026-07-28 and 2025-era clients, without starting a server.
lead: '`createTestClient` connects the official MCP client to an app in memory: no process, no port, the same protocol a real client speaks.'
weight: 58
group: Build with TypeScript
fits: 'Build with TypeScript. Tests call tools the way clients do, so they cover [validation](/docs/framework/how-kervan-works/#the-path-of-a-tool-call), [middleware](/docs/framework/middleware/) and [errors](/docs/framework/errors/) too.'
next:
  - url: /docs/framework/api/
    text: Programmatic API
    note: everything the packages export
  - url: /docs/framework/transports/
    text: Transports
    note: serving the same app for real
---

## Both protocol eras

```ts {check="ts-run" expect="legacy: passed"}
import assert from "node:assert/strict"
import { createApp, z } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"

const app = createApp({ name: "calculator", version: "0.1.0" })
app.tool("add", {
  description: "Adds two numbers.",
  input: z.object({ a: z.number(), b: z.number() }),
  output: z.object({ sum: z.number() }),
  handler: ({ a, b }) => ({ sum: a + b }),
})

// The same checks for a 2026-07-28 client and a 2025-era one, in memory.
for (const era of ["modern", "legacy"] as const) {
  const client = await createTestClient(app, { era })
  const result = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } })
  assert.deepEqual(result.structuredContent, { sum: 5 })
  // Arguments that do not fit the input schema never reach the handler.
  const refused = await client.callTool({ name: "add", arguments: { a: "two", b: 3 } })
  assert.equal(refused.isError, true)
  await client.close()
  console.log(`${era}: passed`)
}
```

A project made by `kervan create` has the same kind of test in `test/app.test.ts`, run with
Vitest (`npm test`); any test runner works.

## Options

{{% include file="packages/transport/README.md" section="Testing: `@kervan/transport/testing`" %}}
