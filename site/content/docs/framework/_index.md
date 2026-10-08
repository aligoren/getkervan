---
title: Kervan framework documentation
navTitle: Framework
seoTitle: Kervan framework docs, a TypeScript MCP framework
description: Concepts of the Kervan MCP framework, a TypeScript layer over the official MCP SDK; tools from a kervan.yaml spec or code, transports, the CLI.
lead: Kervan is a TypeScript framework for Model Context Protocol (MCP) servers, built on the official MCP SDK. Tools come from a `kervan.yaml` spec or from code, with the same guarantees.
weight: 1
cascade:
  ogSection: Framework documentation
---

## What Kervan is

An [MCP](/guides/what-is-mcp/) server offers *tools* that a model can call: a name, a
description, a JSON Schema for the arguments, and a handler that returns a result. Kervan is the
layer between your tools and the official SDK (`@modelcontextprotocol/server` v2):

- **You describe tools**, either in a `kervan.yaml` file (an HTTP request per tool, no code) or in
  TypeScript with Zod schemas.
- **Kervan handles the rest:** argument validation, output schemas, error masking, timeouts, size
  limits, change notifications, and the stdio and Streamable HTTP transports.
- **The protocol is the SDK's.** Kervan does not reimplement MCP.

## The packages

| Package | What it does |
| --- | --- |
| `@kervan/core` | `createApp`, tools, the tool context, middleware, the tool registry. No transport or I/O. |
| `@kervan/transport` | stdio and Streamable HTTP on Node, a fetch handler for Workers, Deno and Bun, multi-tenant `resolveServer`, and `createTestClient`. |
| `@kervan/spec-runtime` | `kervan.yaml` specs: HTTP tools with templates, JMESPath output selection, SSRF protection, secret redaction. |
| `kervan` | The CLI: `kervan create`, `kervan dev` (hot reload, REPL), `kervan run`. |
| `create-kervan` | `npm create kervan`, once the packages are published. |

## Concepts

- **Tool:** a name (`[A-Za-z0-9_.-]`, up to 128 characters), a description the model reads, an
  input schema, an optional output schema, annotations (`readOnlyHint`, `destructiveHint`, ...)
  and a handler.
- **Spec:** a `kervan.yaml` file that declares tools as HTTP requests. Every spec tool compiles to
  an ordinary code tool, so anything a spec does can also be done in code. See the
  [kervan.yaml reference](/docs/framework/spec-reference/).
- **App:** what `createApp()` returns: the tools, middleware and limits of one server.
- **Transport:** how clients reach the app: stdio (a client starts your server as a process) or
  Streamable HTTP. See [transports and authentication](/docs/framework/transports/).
- **Registry:** the set of tools an app serves. It can change while the server runs; connected
  clients are told with `list_changed`.

## Where to go next

1. [Quickstart](/docs/framework/quickstart/): run the example spec and call its tools.
2. [HTTP tools](/docs/framework/http-tools/) and [input and output](/docs/framework/input-output/):
   how a spec turns arguments into a request and a response into a result.
3. [Tools in TypeScript](/docs/framework/code/): the code API.
4. [Security model](/docs/framework/security/): what Kervan protects against and how.

Looking for the optional web UI? See [Studio docs](/docs/studio/).
