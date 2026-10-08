---
title: Playground
seoTitle: Test MCP tools in Kervan Studio's playground
description: Kervan Studio's playground connects a real MCP client to any version of a server, drafts too, through the gateway with a 15-minute token; list and call tools.
lead: Try any version before clients see it, drafts included, through the same gateway clients use.
weight: 80
---

{{< shot name="playground" alt="The playground beside the editor: the tool list with Search city selected, the arguments, and the result returned from Open-Meteo." >}}

## Using it

Open a version in the editor and select **Connect** in the playground. It connects a real MCP
client to the gateway for that version and lists its tools. Pick one: the arguments are filled in
from its input schema. **Call** sends the call; the result appears as text, and **Raw requests and
responses** shows the JSON-RPC traffic.

## How it is protected

- The playground uses a token, not your session cookie: `kvp_` plus a payload signed with a key
  that exists only in the running Studio. It lasts 15 minutes and works only for its own server
  and version.
- The token ends with the session that asked for it: signing out, a timeout, a password or role
  change, or deactivation ends it.
- A draft loads with the same secret vault, host bindings and network rules as a published version,
  so the playground cannot send a secret anywhere publishing would refuse.
- Everything a tool or an upstream API returns is shown as text, never as HTML.
- Playground calls appear in the [call log](/docs/studio/call-logs/) as "Playground".
