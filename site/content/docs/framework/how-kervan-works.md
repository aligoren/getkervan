---
title: How Kervan works
seoTitle: 'How Kervan works: packages and request flow'
description: The packages of the Kervan MCP framework and what each one does, what happens to a tool call from client to result, and how tools change while a server runs.
lead: Three libraries, a command line and a project generator. This page shows which does what, and the path a tool call takes.
weight: 15
group: Concepts
fits: 'Concepts. Read it after the [quickstart](/docs/framework/quickstart/), before choosing between [YAML and TypeScript](/docs/framework/yaml-or-typescript/).'
next:
  - url: /docs/framework/yaml-or-typescript/
    text: YAML or TypeScript?
    note: the same tool written both ways, and when to choose which
  - url: /docs/framework/code/
    text: Tools in TypeScript
  - url: /docs/framework/spec-reference/
    text: The kervan.yaml reference
---

{{< diagram >}}

## The packages

| Package | Responsibility | Depends on |
| --- | --- | --- |
| `@kervan/core` | `createApp`, tool definitions, input and output validation, timeouts, error masking, middleware, the tool registry and its change notifications. No transport, no network, no files. | the official MCP SDK (`@modelcontextprotocol/server`) |
| `@kervan/transport` | Serves an app: stdio and Streamable HTTP on Node, a fetch handler for Workers, Deno and Bun, Host and Origin checks, `authenticate` and `resolveServer`, and `createTestClient` for tests. | `@kervan/core` |
| `@kervan/spec-runtime` | Reads a `kervan.yaml` and turns each entry into an ordinary tool definition that makes an HTTP request: templates, SSRF protection, secret redaction, `select` in a separate process, a rate limit per tool. | `@kervan/core` |
| `kervan` | The command line: `kervan create` (a new project), `kervan dev` (hot reload and a terminal inspector) and `kervan run` (serve a spec). | the three libraries |
| `create-kervan` | What `npm create kervan` runs: it calls `kervan create`. | `kervan` |

`@kervan/core` knows nothing about specs, HTTP or stdio, so a tool written in TypeScript and a
tool loaded from YAML are the same thing once registered.

## The path of a tool call

1. **The client sends `tools/call`.** Over stdio as a line on stdin; over Streamable HTTP as a
   `POST` to `/mcp`. A 2026-07-28 request carries its protocol version and capabilities in
   `_meta`; a 2025-era client first sends `initialize`. See [MCP 2026-07-28 notes](/docs/framework/protocol/).
2. **The transport accepts it, or not.** Over HTTP: the `Host` header must be an allowed host and
   an `Origin`, when there is one, an allowed origin; your `authenticate` runs, then
   `resolveServer` picks the tool set for that caller. On Node, `serveHttp` also limits requests
   per minute (300 by default). See [transports and authentication](/docs/framework/transports/).
3. **The SDK server finds the tool** in the registry the transport chose.
4. **Core validates the arguments** against the tool's input schema. Arguments that do not fit
   are refused before any of your code runs.
5. **Middleware and the handler run** inside one timeout (30 seconds unless the app or the tool
   sets another) and with the client's cancellation signal: app middleware first, then the tool's,
   then the handler. See [middleware](/docs/framework/middleware/).
   - A **TypeScript tool's** handler is your function.
   - A **spec tool's** handler is generated: it fills the URL template, checks the address the
     host name resolves to, makes the request with the spec's limits, redacts secret values from
     the response, and runs `select` in a separate process.
6. **The result goes back.** With an output schema, the result becomes `structuredContent` and
   is checked against the schema. A `ToolError`'s message reaches the client; any other error is
   logged with a reference and the client sees only `Internal error in tool "x" (ref: ...)`. See
   [errors](/docs/framework/errors/).

## What every tool gets, and what spec tools add

| Every tool | Spec tools also |
| --- | --- |
| Arguments validated before the handler | SSRF protection: public addresses only, DNS resolved once and the connection pinned to the checked address |
| A timeout on every call, and the client's cancellation | Secret values redacted from results, errors and logs |
| Errors masked unless they are a `ToolError` | A rate limit per tool (60 calls a minute, 10 at once, unless the spec says otherwise) |
| Output checked against the output schema, when there is one | `select` in a separate process without network or environment |

A TypeScript tool that calls an API does so with your own `fetch`: the spec-tool protections do
not apply to it. To give one code server both, [load a spec into it](/docs/framework/code/#a-spec-tool-in-code).

## Tools that change while the server runs

The tools an app serves live in its registry. `app.tool()`, `app.replaceTool()` and
`app.removeTool()` change it at any time, also while clients are connected; `kervan dev` and
`kervan run --watch` do the same when a file changes. Connected clients are told with
`notifications/tools/list_changed`, once per batch of changes and only when the list really
changed. 2025-era clients over HTTP are the exception: they are served without a session, so
they see the change on their next `tools/list`. See [a registry that changes at runtime](/docs/framework/registry/).
