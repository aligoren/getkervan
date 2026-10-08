---
title: Transports and authentication
seoTitle: 'MCP over stdio and Streamable HTTP with Kervan'
description: 'Serve a Kervan MCP server over stdio or stateless Streamable HTTP, on Node or fetch runtimes, with Host and Origin checks and authentication.'
lead: The same app serves stdio and Streamable HTTP, on Node or on fetch runtimes (Workers, Deno, Bun), for clients of both protocol eras.
weight: 70
group: Run and operate
fits: 'Run and operate. How clients reach the tools you built in [YAML](/docs/framework/spec-reference/) or [TypeScript](/docs/framework/code/).'
next:
  - url: /docs/framework/protocol/
    text: 'MCP 2026-07-28 notes'
  - url: /docs/framework/deployment/
    text: 'Deployment'
---

## Which transport

- **stdio:** the client starts your server as a process and talks over stdin and stdout. This is
  what desktop clients and Claude Code use for local servers. Nothing listens on the network.
- **Streamable HTTP:** your server listens on a URL (`/mcp` by default). Use it for remote
  servers, several clients, or a server behind a proxy. Kervan serves it **statelessly**: no
  sessions, a fresh SDK server per request.

`kervan run spec.yaml` serves stdio; `kervan run spec.yaml --http` serves HTTP on
`127.0.0.1:3000`. In code, `serve(app)` reads `--http`/`--stdio`, then `KERVAN_TRANSPORT`, and
defaults to stdio.

{{% include file="packages/transport/README.md" section="Node: `@kervan/transport/node`" %}}

## Fetch runtimes

{{% include file="packages/transport/README.md" section="Fetch runtimes: `@kervan/transport`" %}}

## Host and Origin checks

HTTP servers check the `Host` header against `allowedHosts` and, when a request has one, the
`Origin` header against `allowedOrigins`. Both default to localhost only. This stops DNS
rebinding: a web page cannot reach your local server through a name it controls. Off localhost,
name the hosts clients use:

```sh {check="starts" ready="Serving open-meteo"}
node packages/cli/bin/kervan.js run examples/spec/kervan.yaml --http --host 0.0.0.0 --allowed-host mcp.example.com
```

Without `--allowed-host`, `kervan run` refuses to listen beyond loopback, and so does
`serveHttp` without `allowedHosts`.

## Authentication

There is no built-in user store: `authenticate(request, { params })` is yours. Return an
`AuthInfo` (tools read it as `ctx.auth`), a `Response` to refuse the request, or `undefined`.
`resolveServer(request, { auth, params })` then picks the tool set for that caller, which is how
one server serves several tenants: derive the tenant from the verified `auth`, never from a
header the client chose, and return the same registry object for the same tenant.

Kervan does not implement OAuth 2.1 with protected resource metadata, which the MCP authorization
specification describes for remote servers; put an authenticating proxy or your own
`authenticate` in front.
