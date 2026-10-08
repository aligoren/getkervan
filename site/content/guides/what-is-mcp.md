---
title: What MCP is, and what Kervan adds
seoTitle: 'What is MCP, and what does Kervan add?'
description: The Model Context Protocol explained in plain terms; servers, tools, clients and transports, and what the Kervan framework adds on top of the official MCP SDK.
lead: The Model Context Protocol (MCP) is an open protocol that lets AI applications use tools and data from other programs. Kervan is a framework for writing the server side.
weight: 10
---

## MCP in one paragraph

An AI application such as Claude Code is an MCP **client**. It connects to MCP **servers**, asks
what **tools** they offer, and lets the model call them. A tool has a name, a description the
model reads to decide when to use it, a JSON Schema for its arguments, and a result. The messages
are JSON-RPC, carried over **stdio** (the client starts the server as a process) or **Streamable
HTTP** (the server listens on a URL). The specification is at
[modelcontextprotocol.io](https://modelcontextprotocol.io).

## What a server answers

This is what a real server answers when a client asks for its tools: the example server of this
project, recorded from a run of `kervan run`.

{{< example part="tools" >}}

And a call of one of those tools, with its result:

{{< example part="call" >}}

## What Kervan adds

The official MCP SDK implements the protocol. Kervan is a thin layer over it
(`@modelcontextprotocol/server` v2) that takes care of what every server needs:

- **Tools without code.** A [`kervan.yaml` spec](/guides/mcp-server-from-yaml/) turns HTTP API calls
  into tools: templates for the request, a JMESPath `select` for the result.
- **Tools in TypeScript** with Zod schemas, when you need logic:
  [tools in TypeScript](/docs/framework/code/).
- **Validation and error masking.** Invalid arguments come back to the model as an error it can fix;
  internal errors are masked with a reference.
- **Limits and protection on by default:** timeouts, size and rate limits, `Host` and `Origin`
  checks, and for spec tools SSRF protection and secret redaction.
- **Both protocol eras** from one app: the stateless 2026-07-28 revision and the 2025 revisions.
- **A development loop:** `kervan dev` reloads on save without dropping the client, with a REPL.

## Next

- [Build an MCP server from a YAML file](/guides/mcp-server-from-yaml/)
- [Connect a Kervan server to Claude Code](/guides/connect-claude-code/)
- [The framework documentation](/docs/framework/)
