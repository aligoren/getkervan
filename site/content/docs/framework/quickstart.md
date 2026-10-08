---
title: Quickstart
seoTitle: Kervan quickstart, run an MCP server in minutes
description: Build Kervan from source, serve the example kervan.yaml spec as an MCP server, call its tools from a REPL, and create a TypeScript project of your own.
lead: Run the example spec, call its tools, then start a project of your own. About ten minutes.
weight: 10
---

## Before you start

You need Node.js **22.23.3 or a later 22.x, or 24.21.0 or later**, and Git. Kervan's commands
refuse older versions with one line that says so. pnpm comes with Node.js through Corepack.

{{< install >}}

The commands below run in the repository folder. On Windows they work the same in PowerShell and
in Git Bash.

## Serve the example spec

`examples/spec/kervan.yaml` declares two tools backed by the public Open-Meteo APIs (no API key
needed). Build the packages once, then serve the spec over Streamable HTTP:

```sh {check="run"}
pnpm build
```

```sh {check="starts" ready="Serving open-meteo"}
node packages/cli/bin/kervan.js run examples/spec/kervan.yaml --http
```

```text
Loaded open-meteo 0.1.0: 2 tool(s)
Serving open-meteo on http://127.0.0.1:3000/mcp
```

Any MCP client can connect to `http://127.0.0.1:3000/mcp` now. Without `--http`, `kervan run`
serves stdio instead, which is what a client that starts the server itself (Claude Code, for
example) uses. Stop it with Ctrl+C.

## Call the tools from a REPL

`kervan dev` serves the same spec with hot reload and, in a terminal, a small REPL that calls tools
the way a client would:

```sh {check="starts" ready="Kervan dev server"}
node packages/cli/bin/kervan.js dev examples/spec/kervan.yaml
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

Edit `examples/spec/kervan.yaml` while it runs: `kervan dev` reloads it, and keeps the last good
version when an edit is invalid.

## Connect a client

To use the server from Claude Code, add it as a stdio server with the absolute path of the
repository:

{{< connect-command >}}

The [Claude Code guide](/guides/connect-claude-code/) covers HTTP servers, scopes and checking the
connection.

## Start your own project

`pnpm try:new` (shown above) creates a TypeScript project with two tools, a test and scripts for
`dev`, `start`, `build` and `test`. In that project:

```sh {check="manual" reason="runs in the project try:new creates, which the install block above checks"}
npm run dev
npm test
```

## Next

- Write your own spec: the [guide to an MCP server from a YAML file](/guides/mcp-server-from-yaml/)
  and the [kervan.yaml reference](/docs/framework/spec-reference/).
- Write tools in code: [tools in TypeScript](/docs/framework/code/).
