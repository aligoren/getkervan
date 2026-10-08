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

Studio needs Node.js 22.23.3 or a later 22.x, or 24.21.0 or later: the oldest releases the whole
test suite has passed on. It refuses to start on anything older (see "Node.js versions" below).

```sh
pnpm build
# Once: create a master key and keep it somewhere safe (a password manager, a secret store).
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
KERVAN_STUDIO_MASTER_KEY=<that key> node apps/studio/bin/kervan-studio.js start
```

In Windows PowerShell, set the variable first:

```powershell
$env:KERVAN_STUDIO_MASTER_KEY = "<that key>"
node apps/studio/bin/kervan-studio.js start
```

Studio encrypts secrets with the master key and does not start without it. A lost master key
means the stored secrets are lost; set them again in the UI.

The database goes into `.kervan-studio/` in the current directory (`KERVAN_STUDIO_DATA_DIR`
changes it). A data directory Studio creates gets a `.gitignore` that keeps it out of git, the
repository ignores `.kervan-studio/`, and Studio warns at start if git could still commit the
database. Studio runs in the foreground; stop it with Ctrl+C, and start it again with the same
data directory and master key. If the port is taken, Studio says so in one line; set
`KERVAN_STUDIO_PORT` to another.

`pnpm build` also builds the web UI (`apps/studio/dist-web`). Then open the URL Studio prints.

On first start, Studio:

1. listens on `127.0.0.1` only (whatever `KERVAN_STUDIO_HOST` says);
2. prints a one-time setup token, valid for 30 minutes, that creates the first admin;
3. issues a new token, and invalidates the old one, on every restart until an admin exists.

### Creating the first admin from the shell

Where the browser cannot reach Studio's loopback address (a container, a remote server without
a tunnel), create the first admin with a command on the host instead:

```sh
node apps/studio/bin/kervan-studio.js create-admin --email admin@example.com
```

- It asks for the password twice and does not show it (type it after the prompt appears: what
  is typed before that, the terminal itself shows, as with any password prompt). Without a
  terminal, pipe it in with `--password-stdin` (one line). The password is never taken from an argument or an environment
  variable: those end up in shell history and process listings.
- The email and the password get the same checks as the setup page.
- It needs the same `KERVAN_STUDIO_DATA_DIR` and `KERVAN_STUDIO_MASTER_KEY` as `start` (a missing
  or wrong key is reported the same way), and works whether or not Studio is running.
- It works only while there is no admin. Admins add other users in the UI; `reset-admin`
  (below) recovers an admin account.
- The setup token Studio printed stops working. A running Studio notices the new admin within a
  few seconds and starts listening on `KERVAN_STUDIO_HOST`; no restart is needed.
- It writes an audit event (`studio.setup` by the command line), without the password.
- The admin signs in with the password they chose (no forced change).

In a container (see `docs/RELEASING.md` for the image draft):

```sh
docker exec -it kervan-studio node apps/studio/bin/kervan-studio.js create-admin --email admin@example.com
```

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
  selected version (drafts too). The token ends with the session that asked for it (sign-out
  ends it). It lists and calls tools, and shows the raw requests and responses. Everything a
  tool or upstream returns is shown as text.
- **Versions:** compare any two versions line by line. Publish an older one to roll back:
  connected clients get `list_changed` (see Gateway for which clients), and the audit log
  records a rollback.
- **Secrets (admins):** values are encrypted and write-only. Each secret has allowed hosts
  (`host` or `host:port`). Before a secret the published version uses can be deleted, Studio
  lists the tools that use it and asks for confirmation.
- **API keys (admins):** a key is shown once when created, with a ready `claude mcp add`
  command for the server's full endpoint URL. Besides the command with the key in it, there are
  bash/zsh and PowerShell versions that ask for the key without echoing it, so it stays out of
  your shell history; each has its own copy button. The list shows a key's prefix and last
  use. Revoking
  asks for confirmation and takes effect at once: open streams of that key are closed.
- **Calls:** tool, caller (the playground, or the API key by name), status and duration of
  recent calls. Admins can also log arguments and results (redacted, cut to 4 KiB).
- **Disable server:** takes a server offline without deleting anything. Its endpoint answers 404,
  open connections close and the playground stops; versions, secrets, keys and call logs stay.
  "Enable server" serves the published version again with the same keys. Same rules as
  publishing, with a confirmation, and both are audited.
- **Publishing a version with problems** is not offered: the button is disabled and says why
  (the server refuses it too).
- **Roles:** members edit, publish, use the playground and see call metadata. Admins also
  manage users, secrets and keys, delete servers, and read payloads and the audit log.
- **Users (admins):** add users, change their role and email, reset their password, and
  deactivate them. Adding a user, a role change and a password reset ask for your own password.
  Users are never deleted, so the audit log keeps pointing at them.
  - A deactivated user is signed out at once, their playground tokens stop working, and they
    cannot sign in until reactivated. Before deactivating, Studio lists the API keys the user
    created and revokes them too unless you uncheck the box (keys belong to servers, so they
    would otherwise keep working). Reactivating does not bring revoked keys back.
  - A password reset asks for your own password, sets a temporary one (yours, or a generated
    one shown once), and signs the user out everywhere. They must choose a new password at
    their next sign-in; until then the API refuses everything else.
  - A role change asks for confirmation and your own password (the server insists too). It
    signs the user out everywhere (their playground tokens end too): they sign in again with
    the new role.
  - The last active admin cannot be deactivated or made a member.
- **Navigation:** a sidebar on wide screens and a menu drawer on phones. Every user sees
  Servers (members edit, validate and publish specs and use the playground), Settings and
  Profile; Users and the audit log are for admins only.
- **Theme:** System, Light or Dark, from the switch in the sidebar or on Settings. The choice is
  saved to your account (not to the browser), so it follows you to every device; signed out,
  Studio follows the system setting.
- **Audit log (admins):** sign-ins and sign-outs, user and profile changes (including the theme),
  servers (created, published, rolled back, refused, settings, deleted), secrets and API keys;
  the latest 100 entries. Passwords, secret values and keys are never recorded.
- **Names and emails** that others see cannot hide anything: invisible, control and
  text-direction characters are refused in emails, display names, server names and key names. A
  display name cannot be "admin" or another reserved label, or another user's email, in any
  lookalike form. A failed sign-in's email is kept in the audit log with such characters shown as
  visible escapes (`\u202E`).
- **Dates and times** are always in English (`Oct 7, 2026`, `3 minutes ago`), whatever the
  browser's language, like the rest of the UI. Hovering one shows the exact time.
- **Focus rings** show when you use the keyboard, not after mouse clicks; text fields always show
  focus. Closing a dialog returns focus to the button that opened it.
- **Narrow screens:** every page fits a 390px-wide phone without sideways scrolling. Tables move
  their secondary columns under the first cell, and a table that is still too wide scrolls in
  its own box, with a fade on the edge that has more.
- **Profile (everyone):** your email and role (only an admin changes those), an optional display
  name, your password (the current one is required; your other sessions are signed out, and
  this one continues under a new session id, so an old copy of its cookie stops working), and
  your active sessions, which you can sign out one by one or all at once.
- **Server status:** the server list shows whether each server is published and whether a newer
  draft is valid, has problems, or was never checked, plus the time of the last call. A new
  server shows a "Next steps" checklist until it is set up.

For UI development, run Studio, then `pnpm --filter @kervan/studio dev:web`. Vite serves the UI
and forwards `/api` and `/s` to Studio on port 4310. The design system's components and tokens
are on the development-only styleguide page (`/styleguide.html` on the Vite server); the
production build does not include it.

End-to-end tests start the built Studio with a throwaway data directory and drive it with
Playwright's Chromium (setup, servers, users, the forced password change, the profile, the theme,
and every page at 390px). They are not part of `pnpm test`:

```sh
pnpm --filter @kervan/studio exec playwright install chromium   # once
pnpm e2e                                                       # build, then Playwright
```

## Gateway

Each published server is served at `/s/{serverId}/mcp` (Streamable HTTP, both protocol eras).
Clients send one of the server's API keys:

```sh
claude mcp add --transport http weather https://studio.example.com/s/<serverId>/mcp \
  --header "Authorization: Bearer kvn_..."
```

To keep the key out of your shell history, read it hidden and pass it through a variable:

```sh
# bash / zsh
printf 'API key: '; read -rs KERVAN_API_KEY; echo
claude mcp add --transport http weather https://studio.example.com/s/<serverId>/mcp \
  --header "Authorization: Bearer $KERVAN_API_KEY"
unset KERVAN_API_KEY
```

```powershell
# PowerShell
$key = Read-Host "API key" -AsSecureString
$env:KERVAN_API_KEY = [Net.NetworkCredential]::new("", $key).Password
claude mcp add --transport http weather https://studio.example.com/s/<serverId>/mcp --header "Authorization: Bearer $env:KERVAN_API_KEY"
Remove-Item Env:KERVAN_API_KEY; Remove-Variable key
```

- A key works for its own server only.
- Missing, unknown, revoked and other-server keys all get the same `401`.
- Publishing a version, or publishing an older one again, updates the server in place.
  Clients on MCP 2026-07-28 that listen (`subscriptions/listen`) get `list_changed` at once;
  2025-era clients, served statelessly over HTTP, see the new tools on their next `tools/list`.
- To take a server offline without deleting it, disable it (see Web UI); a disabled server
  answers 404 like an unknown one.
- A missing, wrong, revoked or other server's key always gets the same 401 body, which says what
  to send: `Unauthorized. Send a valid API key for this server as 'Authorization: Bearer <key>'.`

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

### Example: Caddy

Caddy gets and renews the TLS certificate itself. Its `reverse_proxy` keeps the `Host` header,
sets `X-Forwarded-For` to the client's address (it does not trust what clients send unless you
configure `trusted_proxies`), and streams `text/event-stream` responses without buffering, so
no `flush_interval` setting is needed. (Tested with Caddy 2.11 and `tls internal`: through the
proxy, a client's `subscriptions/listen` stream received `list_changed` about 30 ms after a
publish, also after 65 seconds idle.)

```caddyfile
studio.example.com {
	reverse_proxy 127.0.0.1:4310
}
```

```sh
KERVAN_STUDIO_PUBLIC_URL=https://studio.example.com \
KERVAN_STUDIO_TRUST_PROXY=1 \
KERVAN_STUDIO_HOST=127.0.0.1 \
KERVAN_STUDIO_MASTER_KEY=... \
node apps/studio/bin/kervan-studio.js start
```

With Studio on `127.0.0.1`, only processes on the same machine (Caddy) reach it. The browser
must use exactly `https://studio.example.com`: the management API and the gateway compare the
whole origin (scheme, host and port).

Until the first admin exists Studio listens on `127.0.0.1` only, and Caddy on the same machine
forwards to it. Create the first admin soon after the first start: the setup token, printed
on Studio's console, is what protects a fresh install.

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
- reactivates the admin if they were deactivated;
- writes an audit event (without the password).

It needs access to the data directory, so only someone with a shell on the host can run it.

## Node.js versions

Studio needs Node.js 22.23.3 or a later 22.x, or 24.21.0 or later, and refuses to start on anything else with one line,
before it loads; it reads the range from `engines` in its `package.json`. Those are the oldest
releases the whole test suite has passed on:

- 22.17.1 was tried: Studio's own tests passed, but the framework's tests run TypeScript files
  directly, which needs 22.18, so the run was not green.
- Node.js 22.0 to 22.12 were never tested: they name the permission model differently
  (`--experimental-permission`), and the separate process that runs `select` expressions depends
  on it (threat model, T19).
- 24.x releases before 24.21 crash intermittently on Windows (a libuv bug: `UV_HANDLE_CLOSING`).

## Data and backups

A Studio installation has two things to keep, and they belong in **different** places:

| What | Where | Without it |
| --- | --- | --- |
| The database | `studio.db` in the data directory | Servers, versions, users, keys and logs are gone. |
| The master key | `KERVAN_STUDIO_MASTER_KEY` (outside the data directory) | Stored secrets cannot be decrypted. Studio refuses to start until they are deleted from the database or the key is found. |

Back up the master key once (a password manager or your secret store), and the database
regularly. Keep them apart: someone who gets a database backup should not also get the key,
and the database alone reveals no secret values.

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

To restore, stop Studio, put the backup in place as `studio.db` (with no stale `-wal` or `-shm`
files next to it), and start Studio with the master key that was current when the backup was
made, or a newer one that lists it in `KERVAN_STUDIO_PREVIOUS_MASTER_KEYS`.

## Rotating the master key

1. Create a new key and give it the next version number:
   `KERVAN_STUDIO_MASTER_KEY=2:<new base64>`. A key without a version is version 1.
2. Move the old key to `KERVAN_STUDIO_PREVIOUS_MASTER_KEYS=1:<old base64>` (comma-separated if
   there are several).
3. Restart Studio. It re-encrypts every stored secret with the new key before it serves
   requests, and prints how many it re-encrypted.
4. Back up the database, then remove the old key from `KERVAN_STUDIO_PREVIOUS_MASTER_KEYS`.

If a secret cannot be decrypted with any configured key, Studio does not start and nothing is
changed. Database backups made before the rotation still need the old key: keep it as long as
you keep those backups.

## Upgrading

1. Stop Studio and back up the database (see above).
2. Update the code and rebuild: `pnpm install --frozen-lockfile && pnpm build`.
3. Start Studio. Pending database migrations run at startup; if one fails, Studio does not
   start and reports which.

Migrations only move forward. An older Studio refuses to open a database a newer one has
migrated, so going back to an older version means restoring the backup from step 1.

## Known limits

- **Master key in an environment variable.** A `KeyProvider` (KMS, HSM) can be plugged in from
  code, but the CLI reads the environment only.
- **API keys, not OAuth.** The gateway authenticates with per-server API keys. OAuth 2.1 with
  protected resource metadata, as the MCP authorization spec describes, is future work.
- **One process.** Rate limits and the gateway's registries are in memory, so Studio does not
  run as several instances.
- **No sub-path.** Studio must be served at the root of its origin.
- **Users can be deactivated, not deleted.** Their audit records stay attributed to them.
