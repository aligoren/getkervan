# Kervan Studio

A self-hosted web app for writing `kervan.yaml` MCP servers, publishing them, and serving them to
MCP clients through one gateway. Studio is optional: it is built only on the public API of
`@kervan/core`, `@kervan/transport` and `@kervan/spec-runtime`. Every server can be exported as a
`kervan.yaml` that runs with `kervan run`.

> **Status: in development, not published.** This is phase 4a: data model, gateway and the
> framework extensions Studio needs. The management API and web UI (4b) and the encrypted secret
> vault, version history and key management (4c) come next. Until 4c, secrets are kept in memory.

The security design is in [docs/THREAT-MODEL-STUDIO.md](../../docs/THREAT-MODEL-STUDIO.md).

## Running it

```sh
pnpm build
node apps/studio/bin/kervan-studio.js start
```

On first start, Studio:

1. listens on `127.0.0.1` only (whatever `KERVAN_STUDIO_HOST` says);
2. prints a one-time setup token, valid for 30 minutes, that creates the first admin;
3. issues a new token, and invalidates the old one, on every restart until an admin exists.

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

- **API keys, not OAuth.** The gateway authenticates with per-server API keys. OAuth 2.1 with
  protected resource metadata, as the MCP authorization spec describes, is future work.
- **One process.** Rate limits and the gateway's registries are in memory, so Studio does not
  run as several instances.
- **No sub-path.** Studio must be served at the root of its origin.
