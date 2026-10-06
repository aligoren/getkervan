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

## `kervan run <spec>`

Serves a `kervan.yaml` spec (see [`@kervan/spec-runtime`](../spec-runtime)).

```sh
kervan run kervan.yaml                                   # stdio
kervan run kervan.yaml --http --port 8080                # http://127.0.0.1:8080/mcp
kervan run kervan.yaml --http --host 0.0.0.0 --allowed-host mcp.example.com
kervan run kervan.yaml --env-file .env --watch
```

| Option | |
| --- | --- |
| `--http` | Streamable HTTP instead of stdio |
| `--port`, `--host` | Default `3000` and `127.0.0.1` |
| `--allowed-host <name>` | Host names clients use (repeatable). Required when `--host` is not localhost. |
| `--env-file <path>` | Variables for `{{secrets.X}}` (repeatable). Variables already set win. |
| `--watch` | Reload the spec when it changes; an invalid edit keeps the last good version. |
| `--allow-private-network` | Let tools reach internal addresses. Development only; refused with `NODE_ENV=production`. |
| `--deny-network <cidr>` | An address or range tools may never reach (repeatable); wins over `--allow-private-network`. |

An invalid spec stops `run` with the file, line and column of every problem. Secret values never
appear in the output. Note: Node.js itself checks `--env-file` arguments, even after the script
name, and exits with `<file>: not found` (code 9) when the file is missing.

## `kervan dev <entry>`

Runs your server with hot reload. Your code runs in a child process; `kervan dev` is a stable
MCP server in front of it that clients stay connected to. Given a `.yaml`/`.yml` spec instead,
it reloads the spec in its own process (`--env-file` and `--allow-private-network` work as for
`run`).

```sh
kervan dev src/index.ts            # in a terminal: HTTP on 127.0.0.1:3000 plus a REPL
claude mcp add my-server -- npx kervan dev /abs/path/src/index.ts   # stdio, for MCP clients
```

| Option | |
| --- | --- |
| `--http` / `--stdio` | Default: HTTP with a REPL in a terminal, stdio when started by a client |
| `--port <port>` | HTTP port (default 3000). The host is always `127.0.0.1`. |
| `--drain-timeout <ms>` | How long a reload waits for running calls (default 10000) |
| `--repl` / `--no-repl` | Force the terminal inspector on or off (HTTP mode) |
| `--no-watch` | Do not restart on file changes |

- **Reloads.** Saving a `.ts`/`.js`/`.json` file (outside `node_modules`, `dist`, `.git`)
  starts a new child first; only when it is up does `kervan dev` switch to it, so a syntax error
  keeps the last good version running. Clients get `list_changed` only if the tools actually
  changed. The server's own runtime changes (`app.tool()` at runtime) are followed too.
- **Running calls.** The previous child keeps running until its calls finish, up to
  `--drain-timeout`. Calls still running then fail with "interrupted because the server reloaded".
- **Stopping the child** never uses signals, which cannot ask a Windows process to shut down:
  `kervan dev` closes the child's stdin (a stdio MCP server exits on EOF), and if the process is
  still alive after 2 seconds it kills the process tree (`taskkill /T /F` on Windows).
- **Security.** HTTP mode only binds to `127.0.0.1` and keeps the `Host`/`Origin` checks, so a
  web page cannot reach your tools through DNS rebinding. Values of secret-looking environment
  variables (`*_TOKEN`, `*_API_KEY`, `*PASSWORD*`, `DATABASE_URL`, ...) and credentials in URLs are
  replaced with `[redacted]` in everything `kervan dev` prints and in error results it forwards.
- **Development only.** `kervan dev` refuses to start with `NODE_ENV=production`. File watching
  lives only in this CLI; `@kervan/core` and `@kervan/transport` never watch files.
- On Windows with Node.js 24 older than 24.21, `kervan dev` warns about a libuv bug that can
  crash Node.js processes.

REPL commands: `tools`, `call <tool> [json]`, `reload`, `help`, `exit`. Calls go through the same
app that serves clients, so validation and error masking match what a client sees.
