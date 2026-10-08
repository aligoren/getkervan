---
title: Tools in TypeScript
seoTitle: Write MCP tools in TypeScript with Kervan and Zod
description: Write MCP tools in TypeScript with @kervan/core, Zod input and output schemas, the tool context, ToolError, middleware and a registry that changes at runtime.
lead: When a tool needs logic, write it in TypeScript. `@kervan/core` builds the official SDK server; you write the handler.
weight: 50
group: Build with TypeScript
fits: 'Build with TypeScript. The first page of the group: the code API. [Errors](/docs/framework/errors/), [middleware](/docs/framework/middleware/), the [registry](/docs/framework/registry/) and [testing](/docs/framework/testing/) follow; the [programmatic API](/docs/framework/api/) lists every export.'
next:
  - url: /docs/framework/errors/
    text: 'Errors'
  - url: /docs/framework/middleware/
    text: 'Middleware'
  - url: /docs/framework/api/
    text: 'Programmatic API'
---

## A complete server

This program defines a tool, then calls it the way a client would, through `createTestClient`
(in memory, no network). It is `examples/calculator/src/calculator.ts` in the repository; from a
clone, `node examples/calculator/src/calculator.ts` prints `sum: 5`. In a project made by
`kervan create` (or `pnpm try:new`), save it as `src/calculator.ts` and run it the same way:

{{< code-file file="examples/calculator/src/calculator.ts" lang="ts" check="ts-run" expect="sum: 5" id="calculator" >}}

To serve it instead, replace the last four lines with `await serve(app)` from
`@kervan/transport/node` (see [transports](/docs/framework/transports/)).

{{% include file="packages/core/README.md" section="`createApp(options)`" %}}

## Defining a tool

{{% include file="packages/core/README.md" section="`app.tool(name, definition)`" %}}

## The tool context

{{% include file="packages/core/README.md" section="Tool context" %}}

## Errors, middleware and runtime changes

Each has its own page: [errors](/docs/framework/errors/) (`ToolError` and masking),
[middleware](/docs/framework/middleware/) (code around every call) and
[a registry that changes at runtime](/docs/framework/registry/) (`list_changed`).

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
