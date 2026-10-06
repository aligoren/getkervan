# Kervan Studio

A self-hosted web app for writing `kervan.yaml` MCP servers, publishing them, and serving them to
MCP clients through one gateway. Studio is optional: it is built only on the public API of
`@kervan/core`, `@kervan/transport` and `@kervan/spec-runtime`. Every server can be exported as a
`kervan.yaml` that runs with `kervan run`.

> **Status: in development, not published.** Phases 4a, 4b and 4c are done:
> - gateway and data model;
> - management API, web UI, spec editor and playground;
> - encrypted secret vault, version history and rollback, API keys and call logs.

The security design is in [docs/THREAT-MODEL-STUDIO.md](../../docs/THREAT-MODEL-STUDIO.md).

## Running it

```sh
pnpm build
# Once: create a master key and keep it somewhere safe (a password manager, a secret store).
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
KERVAN_STUDIO_MASTER_KEY=<that key> node apps/studio/bin/kervan-studio.js start
```

Studio encrypts secrets with the master key and does not start without it. A lost master key
means the stored secrets are lost; set them again in the UI.

`pnpm build` also builds the web UI (`apps/studio/dist-web`). Then open the URL Studio prints.

On first start, Studio:

1. listens on `127.0.0.1` only (whatever `KERVAN_STUDIO_HOST` says);
2. prints a one-time setup token, valid for 30 minutes, that creates the first admin;
3. issues a new token, and invalidates the old one, on every restart until an admin exists.

## Web UI

- **Setup and sign-in:** the first admin is created in the browser with the setup token.
  Sessions use an HttpOnly cookie, and every change needs the session's CSRF token.
- **Servers:** create a server, then edit its `kervan.yaml` in the Monaco editor, which has
  completion and validation from the published editor schema.
  - Saving creates a new immutable version; problems show with line and column.
  - Publishing validates the version strictly (including secret bindings) and updates the
    gateway in place.
  - Any version can be exported as `kervan.yaml`.
- **Playground:** connects a real MCP client to the gateway with a 15-minute token for the
  selected version (drafts too). It lists and calls tools, and shows the raw requests and
  responses. Everything a tool or upstream returns is shown as text.
- **Versions:** compare any two versions line by line. Publish an older one to roll back:
  connected clients get `list_changed`, and the audit log records a rollback.
- **Secrets (admins):** values are encrypted and write-only. Each secret has allowed hosts
  (`host` or `host:port`). Before a secret the published version uses can be deleted, Studio
  lists the tools that use it and asks for confirmation.
- **API keys (admins):** a key is shown once when created; the list shows its prefix and last
  use. Revoking takes effect at once.
- **Calls:** tool, status and duration of recent calls. Admins can also log arguments and
  results (redacted, cut to 4 KiB).
- **Roles:** members edit, publish, use the playground and see call metadata. Admins also
  manage users, secrets and keys, delete servers, and read payloads and the audit log.

For UI development, run Studio, then `pnpm --filter @kervan/studio dev:web`. Vite serves the UI
and forwards `/api` and `/s` to Studio on port 4310.

## Gateway

Each published server is served at `/s/{serverId}/mcp` (Streamable HTTP, both protocol eras).
Clients send one of the server's API keys:

```sh
claude mcp add --transport http weather https://studio.example.com/s/<serverId>/mcp \
  --header "Authorization: Bearer kvn_..."
```

- A key works for its own server only.
- Missing, unknown, revoked and other-server keys all get the same `401`.
- Publishing a version, or publishing an older one again, updates the server in place, and
  connected clients get `list_changed`.

## Configuration

| Variable | Default | |
| --- | --- | --- |
| `KERVAN_STUDIO_PUBLIC_URL` | `http://127.0.0.1:<port>` | The URL people use, e.g. `https://studio.example.com`. Required when not on loopback. Origin checks, cookies, the accepted `Host` header and the SSRF deny list derive from it. |
| `KERVAN_STUDIO_HOST` | `127.0.0.1` | Interface to listen on once an admin exists. |
| `KERVAN_STUDIO_PORT` | `4310` | |
| `KERVAN_STUDIO_DATA_DIR` | `./.kervan-studio` | Holds `studio.db`. |
| `KERVAN_STUDIO_TRUST_PROXY` | `0` | Number of reverse proxies that append to `X-Forwarded-For`. **Only set it when Studio is reachable through the proxy alone** (see below). |
| `KERVAN_STUDIO_DENY_NETWORK` | | Comma-separated addresses or CIDR ranges spec tools may never reach (your internal services). |
| `KERVAN_STUDIO_MASTER_KEY` | (required) | `[version:]base64` of 32 random bytes; encrypts stored secrets. |
| `KERVAN_STUDIO_PREVIOUS_MASTER_KEYS` | | `version:base64,...`: older keys while rotating. Studio re-encrypts with the current key on start. |
| `KERVAN_STUDIO_LOG_RETENTION_DAYS` | `30` | How long call logs are kept. |

There is deliberately no setting that lets spec tools reach private or loopback addresses.

## Behind a reverse proxy

Terminate TLS at the proxy, and make Studio reachable **only** through it: bind Studio to
`127.0.0.1` or a private interface. Then:

- set `KERVAN_STUDIO_PUBLIC_URL` to the public `https://` origin;
- set `KERVAN_STUDIO_TRUST_PROXY` to the number of proxies in front of Studio (usually `1`);
- keep the original `Host` header (`proxy_set_header Host $host;` in nginx) and append to
  `X-Forwarded-For` (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`).

Studio takes the client IP from the entry its outermost trusted proxy wrote. Anything a client
writes into `X-Forwarded-For` itself is ignored.

> **Warning:** with `KERVAN_STUDIO_TRUST_PROXY` set, Studio must not be reachable except
> through the proxy. Firewall its port. A client that connects directly can put any address
> in `X-Forwarded-For`, which defeats per-IP rate limits and falsifies audit records.

## Recovering admin access

```sh
node apps/studio/bin/kervan-studio.js reset-admin [--email admin@example.com] [--password-stdin]
```

This command:

- sets a new password, generated and shown once, or read from stdin;
- ends that admin's sessions;
- writes an audit event (without the password).

It needs access to the data directory, so only someone with a shell on the host can run it.

## Data and backups

- The database is one SQLite file, `studio.db`, opened in WAL mode.
- On Linux and macOS, the data directory is made `0700` and the files `0600`. On Windows, keep
  the data directory somewhere only the Studio user can read.
- Studio refuses to start when a migration fails, or when the database was written by a newer
  Studio.

To back up a running Studio, use SQLite's online backup rather than copying the file. Data that
is still only in the `-wal` file would be missing from a plain copy.

```sh
sqlite3 .kervan-studio/studio.db ".backup 'studio-backup.db'"
# or: sqlite3 .kervan-studio/studio.db "VACUUM INTO 'studio-backup.db'"
```

If you copy files while Studio is stopped, copy `studio.db` together with any `studio.db-wal`
and `studio.db-shm` next to it.

## Known limits

- **Master key in an environment variable.** A `KeyProvider` (KMS, HSM) can be plugged in from
  code, but the CLI reads the environment only.
- **API keys, not OAuth.** The gateway authenticates with per-server API keys. OAuth 2.1 with
  protected resource metadata, as the MCP authorization spec describes, is future work.
- **One process.** Rate limits and the gateway's registries are in memory, so Studio does not
  run as several instances.
- **No sub-path.** Studio must be served at the root of its origin.
