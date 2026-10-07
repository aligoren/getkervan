# {{name}}

An MCP server built with Kervan.

```sh
npm run dev        # hot reload + terminal inspector
npm start          # stdio
npm run start:http # Streamable HTTP on http://127.0.0.1:3000/mcp
npm test
```

Connect it to Claude Code:

```sh
claude mcp add {{name}} -- node /absolute/path/to/{{name}}/src/index.ts
```

Tools live in `src/app.ts`. Relative imports use the `.ts` extension so Node.js can run the
sources directly (Node.js {{nodeEngines}}); `npm run build` compiles them to `dist/`.
