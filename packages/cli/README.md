# kervan

Command line tools for [Kervan](../../README.md) MCP servers.

```sh
npx kervan create my-server          # or: npm create kervan@latest my-server
cd my-server && npm run dev
```

## `kervan create <dir>`

Creates a project from the `basic` template: an app with two tools, a test using
`createTestClient`, and scripts for `dev`, `start`, `build` and `test`.

| Option | |
| --- | --- |
| `--name <name>` | npm package name (default: the directory name) |
| `--pm <manager>` | `npm`, `pnpm`, `yarn` or `bun` (default: the one that ran `create`, else `npm`) |
| `--no-install` | Do not install dependencies |

The target directory must be new or empty.

Generated projects run TypeScript directly with Node.js's built-in type stripping, so they need
Node.js **22.18.0+** (or 23.6.0+); `create` refuses to run on older versions. Relative imports use
the `.ts` extension, and the `tsconfig.json` enables `rewriteRelativeImportExtensions` (so `tsc`
emits `.js` imports) and `erasableSyntaxOnly` (no enums or namespaces, which type stripping
cannot run).
