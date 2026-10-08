---
title: Kervan framework documentation
navTitle: Framework
menuTitle: Introduction
groups: [Start, Concepts, Build with YAML, Build with TypeScript, Run and operate]
seoTitle: Kervan framework docs, a TypeScript MCP framework
description: Concepts of the Kervan MCP framework, a TypeScript layer over the official MCP SDK; tools from a kervan.yaml spec or code, transports, the CLI.
lead: Kervan is a TypeScript framework for Model Context Protocol (MCP) servers, built on the official MCP SDK. Tools come from a `kervan.yaml` spec or from code, on the same validated, timed core.
weight: 1
cascade:
  ogSection: Framework documentation
group: Start
fits: 'The start of the framework book. Every other page goes deeper into one part; the [quickstart](/docs/framework/quickstart/) runs a server first.'
next:
  - url: /docs/framework/quickstart/
    text: 'Quickstart'
    note: 'run the example spec and call its tools'
  - url: /docs/framework/how-kervan-works/
    text: 'How Kervan works'
    note: 'the packages and the path of a tool call'
  - url: /docs/framework/yaml-or-typescript/
    text: 'YAML or TypeScript?'
    note: 'which way to write your tools'
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

## How it is organized

Three libraries (`@kervan/core`, `@kervan/transport`, `@kervan/spec-runtime`), the `kervan`
command line and `create-kervan`. [How Kervan works](/docs/framework/how-kervan-works/) shows
which does what and the path a tool call takes; [YAML or TypeScript?](/docs/framework/yaml-or-typescript/)
helps you choose how to write your tools.

This book follows the same order:

- **Start:** this page and the [quickstart](/docs/framework/quickstart/).
- **Concepts:** [how Kervan works](/docs/framework/how-kervan-works/) and
  [YAML or TypeScript?](/docs/framework/yaml-or-typescript/)
- **Build with YAML:** the [kervan.yaml reference](/docs/framework/spec-reference/),
  [HTTP tools](/docs/framework/http-tools/), [input and output](/docs/framework/input-output/),
  [select](/docs/framework/select/) and [secrets](/docs/framework/secrets/).
- **Build with TypeScript:** [tools in TypeScript](/docs/framework/code/),
  [errors](/docs/framework/errors/), [middleware](/docs/framework/middleware/), the
  [registry](/docs/framework/registry/), [testing](/docs/framework/testing/) and the
  [programmatic API](/docs/framework/api/).
- **Run and operate:** [transports and authentication](/docs/framework/transports/),
  [MCP 2026-07-28 notes](/docs/framework/protocol/), the [CLI](/docs/framework/cli/),
  [deployment](/docs/framework/deployment/), the [security model](/docs/framework/security/),
  [troubleshooting](/docs/framework/troubleshooting/) and [versioning](/docs/framework/versioning/).

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


Looking for the optional web UI? See [Studio docs](/docs/studio/).
