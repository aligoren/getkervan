---
title: A registry that changes at runtime
menuTitle: Registry
seoTitle: Change MCP tools at runtime with Kervan
description: Add, replace and remove Kervan MCP tools while clients are connected; the tool registry, list_changed notifications, and custom registries for many tenants.
lead: The tools an app serves live in its registry, and the registry can change at any time. Connected clients are told.
weight: 56
group: Build with TypeScript
fits: 'Build with TypeScript. The registry is what the transports serve; [how Kervan works](/docs/framework/how-kervan-works/#tools-that-change-while-the-server-runs) shows where it sits.'
next:
  - url: /docs/framework/testing/
    text: Testing
  - url: /docs/framework/transports/#authentication
    text: Authentication and resolveServer
    note: one registry per tenant
  - url: /docs/framework/protocol/#list_changed
    text: list_changed and the protocol eras
---

## Change the tool set while a client is connected

```ts {check="ts-run" expect="after: multiply (list_changed: 1)"}
import { createApp, z } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"

const app = createApp({ name: "registry", version: "0.1.0" })
app.tool("add", {
  description: "Adds two numbers.",
  input: z.object({ a: z.number(), b: z.number() }),
  handler: ({ a, b }) => String(a + b),
})

const client = await createTestClient(app)
let notified = 0
client.setNotificationHandler("notifications/tools/list_changed", () => {
  notified++
})
// A 2026-07-28 client asks for change notifications on its subscriptions/listen stream.
await client.listen({ toolsListChanged: true })
const names = async () => (await client.listTools()).tools.map((tool) => tool.name).join(", ")
console.log(`before: ${await names()}`)

// While the client is connected: one tool more, one tool less, announced once.
app.tool("multiply", {
  description: "Multiplies two numbers.",
  input: z.object({ a: z.number(), b: z.number() }),
  handler: ({ a, b }) => String(a * b),
})
app.removeTool("add")
await new Promise((resolve) => setTimeout(resolve, 100))

console.log(`after: ${await names()} (list_changed: ${notified})`)
await client.close()
```

Adding `multiply` and removing `add` in the same tick is one change: the client gets one
`notifications/tools/list_changed`. A client of the 2025 revisions connected over HTTP gets none
(it has no session to receive it on) and sees the new list on its next `tools/list`.

## The registry API

{{% include file="packages/core/README.md" section="Registry" %}}
