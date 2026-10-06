# Weather example

An MCP server built with Kervan. It has three tools:

- `get_weather`: current weather for a city from [Open-Meteo](https://open-meteo.com) (no API key).
  It shows structured output, `ToolError`, forwarding `ctx.signal` and returning only selected
  fields from an external API.
- `add`: a deterministic tool for checking the connection.
- `countdown`: progress notifications and `ctx.log`.

## Run

From the repository root:

```sh
pnpm install && pnpm build
node examples/weather/dist/index.js          # stdio
node examples/weather/dist/index.js --http   # http://127.0.0.1:3000/mcp
```

## Connect

```sh
# Claude Code
claude mcp add kervan-weather -- node /absolute/path/to/examples/weather/dist/index.js

# MCP Inspector (CLI mode)
npx @modelcontextprotocol/inspector --cli node examples/weather/dist/index.js --method tools/list
npx @modelcontextprotocol/inspector --cli node examples/weather/dist/index.js \
  --method tools/call --tool-name add --tool-arg a=2 --tool-arg b=3
```

`src/worker.ts` shows the same app as a Cloudflare Workers / Deno / Bun fetch handler.
`test/app.test.ts` tests it with `createTestClient`, stubbing `fetch`.
