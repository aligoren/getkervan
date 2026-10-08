---
title: Connect a Kervan server to Claude Code
seoTitle: 'Connect a Kervan MCP server to Claude Code'
description: Add a Kervan MCP server to Claude Code with claude mcp add, as a local stdio server or over HTTP, check that it connects, and remove it; with Windows notes.
lead: Claude Code is an MCP client. One command adds a Kervan server to it, as a local process or as a URL.
weight: 40
menuTitle: 'Connect Claude Code'
---

You need [Claude Code](https://code.claude.com/docs) and Kervan built from a clone
([quickstart](/docs/framework/quickstart/)). Use absolute paths: Claude Code starts the server from
its own working folder.

## A local server over stdio

Claude Code starts the server itself and talks over stdin and stdout. Nothing listens on the
network.

{{< connect-command >}}

On Windows the same command works in PowerShell with Windows paths, for example
`node C:\path\to\kervan\packages\cli\bin\kervan.js run C:\path\to\kervan\examples\spec\kervan.yaml`.

Check it:

```sh {check="claude" id="stdio"}
claude mcp get open-meteo
```

```text
open-meteo:
  Scope: Local config (private to you in this project)
  Status: ✓ Connected
  Type: stdio
```

`--scope` chooses who sees the server: `local` (the default: you, in this project), `project`
(written to `.mcp.json` for everyone in the repository; each person approves it once) or `user`
(you, in every project).

## A server over HTTP

Start the server with `--http`, then add its URL. It gets its own name, `open-meteo-http`, next to
the stdio one:

```sh {check="starts" ready="Serving open-meteo"}
node packages/cli/bin/kervan.js run examples/spec/kervan.yaml --http
```

```sh {check="claude" id="http"}
claude mcp add --transport http open-meteo-http http://127.0.0.1:3000/mcp
claude mcp get open-meteo-http
```

A remote server needs its host name in `--allowed-host`; see
[transports](/docs/framework/transports/#host-and-origin-checks). A server behind an API key gets
it as a header, `--header "Authorization: Bearer <key>"`. The
[self-hosted gateway guide](/guides/self-host-mcp-gateway/) shows how to keep the key out of your
shell history.

## Use it

In Claude Code, ask for something the tools can answer, such as "What's the weather in Ankara right
now?". Claude Code asks before it calls a tool for the first time; `/mcp` in a session lists the
servers and their tools.

## Remove it

```sh {check="claude" id="remove"}
claude mcp remove open-meteo
claude mcp remove open-meteo-http
```
