---
title: MCP 2026-07-28 notes
seoTitle: 'MCP 2026-07-28: _meta, discover, list_changed'
description: What the stateless MCP 2026-07-28 revision changes and how Kervan serves it next to 2025-era clients; _meta on every request, server/discover, list_changed.
lead: Kervan serves the 2026-07-28 revision of MCP and the 2025 revisions (up to 2025-11-25) from the same app. This page explains what differs.
weight: 90
---

## Stateless requests

In 2026-07-28 there is no `initialize` handshake and no session. Every request carries its own
context in `params._meta`: the protocol version and the client's capabilities. Over HTTP the
method also travels in headers (`MCP-Protocol-Version`, `MCP-Method`, and `MCP-Name` for tool
calls), so proxies can route without reading the body.

Here is a real request to the example server and its answer, recorded from `kervan run --http`:

{{< example part="call" index="0" >}}

## server/discover

A client that wants to know what a server offers before calling it sends `server/discover`. The
answer lists the supported versions, the capabilities, the server's instructions (a spec's
`description`) and its name and version in `_meta`:

{{< example part="discover" >}}

`tools/list` answers with each tool's name, title, description, input and output schemas and
annotations:

{{< example part="tools" >}}

## list_changed

When the tool set changes (an `app.tool()` at runtime, a reloaded spec), clients are told with
`notifications/tools/list_changed`, only when the list really changed:

- **2026-07-28 clients** receive it on their `subscriptions/listen` stream, over stdio and HTTP.
- **2025-era clients over stdio** (and in memory) receive it too.
- **2025-era clients over HTTP** do not: Kervan serves them statelessly, without the session
  stream a push would need (`GET` and `DELETE` get `405`). They see the change on their next
  `tools/list`.

## Clients of the 2025 revisions

They are served from the same app, statelessly over HTTP: `initialize` works, sessions are not
created. A server can refuse them with `legacy: "reject"` on the HTTP handler.

## Logging

`ctx.log` writes to the server's logger (stderr) only. Forwarding log messages to the client
(`notifications/message`) is opt-in with `protocolLogging`, and only happens when the request's
`_meta` asks for a `logLevel`; the logging capability is not declared by default.
