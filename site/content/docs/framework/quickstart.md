---
title: Quickstart
seoTitle: Kervan quickstart, run an MCP server in minutes
description: Install Kervan's 0.1 release candidate from npm, create a TypeScript project, serve a kervan.yaml spec as an MCP server and call its tools from a REPL.
lead: Create a project, serve a spec, call its tools. About ten minutes.
weight: 10
group: Start
fits: 'Start. The first run, before any concept; [how Kervan works](/docs/framework/how-kervan-works/) explains what you just ran.'
next:
  - url: /docs/framework/how-kervan-works/
    text: 'How Kervan works'
  - url: /guides/mcp-server-from-yaml/
    text: 'Build an MCP server from a YAML file'
    note: 'a guide to your own spec'
  - url: /docs/framework/code/
    text: 'Tools in TypeScript'
    note: 'tools in code'
---

## Before you start

You need Node.js **22.23.3 or a later 22.x, or 24.21.0 or later**. Kervan's commands refuse older
versions with one line that says so.

## Create a project

{{< install >}}

The project has two tools in TypeScript, a test, and scripts for `dev`, `start`, `build` and
`test`. `npm run dev` serves it with hot reload and, in a terminal, a small REPL that calls tools
the way a client would: type `tools`, then call one. In another terminal, in the project:

```sh {check="manual" reason="runs in the project npm create makes; pnpm verify:published runs the same steps against the registry"}
npm test
```

## Serve a spec

A spec declares tools without code. This one has two tools backed by the public Open-Meteo APIs (no
API key needed). Save it as `kervan.yaml`:

{{< code-file file="examples/spec/kervan.yaml" lang="yaml" label="kervan.yaml" check="spec" >}}

Then serve it over Streamable HTTP:

```sh {check="manual" reason="runs the published package; pnpm verify:published serves this spec the same way"}
npx kervan@next run kervan.yaml --http
```

```text
Loaded open-meteo 0.1.0: 2 tool(s)
Serving open-meteo on http://127.0.0.1:3000/mcp
```

Any MCP client can connect to `http://127.0.0.1:3000/mcp` now. Without `--http`, `kervan run`
serves stdio instead, which is what a client that starts the server itself (Claude Code, for
example) uses. Stop it with Ctrl+C.

## Call the tools from a REPL

`kervan dev` serves the same spec with hot reload and, in a terminal, the REPL:

```sh {check="manual" reason="runs the published package interactively"}
npx kervan@next dev kervan.yaml
```

Type `tools`, then call one. The result is the real answer from Open-Meteo, so yours shows today's
weather:

```text
kervan> tools
  search_city  Finds up to 5 places by name and returns their coordinates.
  get_current_weather  Current temperature (°C), wind speed (km/h) and WMO weather code at a coordinate.
kervan> call get_current_weather {"latitude": 39.92, "longitude": 32.85}
{"temperatureC":21.2,"windKmh":6.2,"weatherCode":2}
structured: {"temperatureC":21.2,"windKmh":6.2,"weatherCode":2}
```

Edit `kervan.yaml` while it runs: `kervan dev` reloads it, and keeps the last good version when an
edit is invalid.

## Connect a client

To use the server from Claude Code, add it as a stdio server with the absolute path of the spec:

{{< connect-command >}}

The [Claude Code guide](/guides/connect-claude-code/) covers HTTP servers,
scopes and checking the connection.

## Add Kervan to a project you have

```sh {check="manual" reason="needs a project of your own"}
npm install @kervan/core@next @kervan/transport@next
npm install --save-dev kervan@next
```

## From source

To run the repository's latest code instead of the release candidate, build it from a clone (pnpm
comes with Node.js through Corepack):

{{< clone >}}

From a clone, run the CLI as `node packages/cli/bin/kervan.js <command>`, and `pnpm try:new <dir>`
creates a project from the local packages.
