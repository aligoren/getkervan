# Kervan Studio threat model

Kervan Studio is a self-hosted web app: people write `kervan.yaml` specs in a browser, publish
them, and MCP clients use them through Studio's gateway at `/s/{serverId}/mcp`. This document
lists who interacts with Studio, what must be protected, the attacks we design against, and how
each one is mitigated and tested.

Status legend: **4a** is implemented (gateway, data model, framework extensions). **4b**
(management API and web UI) and **4c** (encrypted vault, versions, API key management, logs) are
planned and listed so the design is reviewed as a whole.

## Deployment model

- One Studio process with one SQLite database (single tenant). Every table has a
  `workspace_id`, and every query filters by one, so that tenant boundaries already exist.
- Studio sits behind a TLS-terminating reverse proxy, or listens on loopback for local use.
  `KERVAN_STUDIO_PUBLIC_URL` is the canonical origin. Origin checks, cookie flags, the accepted
  `Host` header and the SSRF deny list all derive from it.
- Studio depends only on the public API of `@kervan/core`, `@kervan/transport` and
  `@kervan/spec-runtime`. The framework knows nothing about Studio. Every server can be
  exported as a `kervan.yaml` that runs with `kervan run`.

## Actors

| Actor | Trust | Can do |
| --- | --- | --- |
| **Admin** | Trusted operator | Everything; the only role that writes secrets, their host bindings and API keys. |
| **Member** | Semi-trusted | Writes and publishes specs; uses secrets **by name** but never sees values. May try to exfiltrate secrets through a spec. |
| **MCP client** | Untrusted | Calls the gateway with a server's API key; chooses all tool arguments. |
| **Upstream API** | Untrusted | Answers spec tools' requests; its responses, headers and redirects are attacker-controlled. |
| **Model** | Untrusted channel | Reads tool descriptions and results (prompt injection travels this way). |
| **Network attacker** | Untrusted | Reaches Studio over the network or through a victim's browser (CSRF, DNS rebinding, XSS payloads). |
| **Operator shell** | Trusted | Runs `kervan-studio` commands on the host (setup token, `reset-admin`). |

## Assets

- Secret values (upstream API keys) and the master encryption key (4c).
- Specs and their versions, and the pointer to the published version.
- Gateway API keys and management sessions.
- The audit log.
- Studio's own network position: the database file, cloud metadata services, internal services
  that Studio's host can reach.

## Attacks and mitigations

Every mitigation below is covered by a test. Security checks are also mutation-tested: each
check was deliberately broken, and at least one test had to fail.

At the end of 4a, an independent reviewer with no prior project context tested these claims.
All 8 findings are fixed. The reviewer's tests are kept in `apps/studio/test/review` and
`packages/spec-runtime/test/review`.

### T1: Secret exfiltration through a spec (4a)

*A member writes `{{secrets.API_KEY}}` into a tool that calls a host they control.*

- **Bindings are authoritative and admin-owned.** Each secret has a non-empty list of allowed
  hosts. A spec's own `secrets: [{ name, hosts }]` can only narrow it: effective = Studio ∩
  spec. Entries are `host` or `host:port` (port 443 when omitted), so a secret never goes to
  another port of a bound host. Matching is exact and on normalized values: no subdomains,
  suffixes or wildcards.
- **Three checks**, each tested on its own:
  1. **Publish:** `loadSpec` with `requireSecrets` asks Studio's source for each (secret, host)
     pair. A host outside the binding fails the publish.
  2. **Spec load:** a spec-bound secret used against another host is a load error. This is also
     what keeps an exported file safe under `kervan run`.
  3. **Every call and every redirect hop:** the executor asks the source again with the target
     host (`SecretSource.get(name, { host, tool })`). A binding narrowed after publishing applies
     at once.
- **Redirects:**
  - A redirect to a host that may not receive the tool's secrets is not followed. This covers
    open redirects that reflect a secret into the `Location` URL.
  - Cross-origin hops keep only `Accept` and `User-Agent`, and drop those too if they carry a
    secret. A request body is never sent to another origin.
- Framework extension (generic, not Studio-specific): `SecretSource.get(name, context?)` and
  host-bound `secrets` entries in the spec format.

### T2: A secret value coming back out (4a; vault 4c)

- Secret stores are write-only. Their only read path is the runtime source, and it answers only
  for an allowed host. Listing returns names, hosts and dates.
- **Upstream data is redacted before the spec's `select` expression or output truncation runs
  on it.** Otherwise a spec could:
  - reshape a reflected secret (upper-case it, reverse it, split it);
  - ask yes/no questions about it (`starts_with`, `length`);
  - cut it to a prefix.

  In each case the result would no longer match the redaction patterns.
- Tool results and `ToolError` messages are then redacted again, in raw, URL-encoded,
  form-encoded and JSON-escaped forms. Studio's logger redacts every known value from messages
  and serialized data.
- **A secret never travels over plain http.** A spec author can set `allowInsecureHttp`, but
  a tool that uses secrets is refused at load time and again before sending. This is the
  framework's default, so `kervan run` enforces it too. Tools without secrets may still use
  http.
- The export writes bindings, never values.
- A test scans every surface 4a has and finds no form of the value:
  - tool results in both protocol eras, error results and raw HTTP bodies;
  - logs, export output, audit rows and validation output;
  - binding listings and a full database dump.
- Secret values are at least 8 characters (shorter ones cannot be redacted reliably). Error
  messages about a value never include it.

### T3: SSRF (4a)

- Studio builds its network policy with `studioNetworkPolicy`, field by field. It has **no**
  `allowPrivate`: not in config, environment, UI, API or spec. An `allowPrivate` passed in is
  dropped (tested), and a source scan fails if any Studio code sets it.
- Refused, on top of the runtime's rules (public unicast only, DNS pinned, IPv4-mapped and
  encoded forms refused, this machine's interface addresses refused):
  - cloud metadata addresses, including Azure's WireServer (168.63.129.16), which is a public
    address. The framework refuses these by default, before any other rule, so `kervan run`
    (even with `--allow-private-network`) refuses them too;
  - `KERVAN_STUDIO_DENY_NETWORK` (internal infrastructure). Studio refuses to start if an
    entry is not an address or CIDR range;
  - the addresses of `KERVAN_STUDIO_PUBLIC_URL`, resolved at startup, so tools cannot call back
    into Studio through its proxy.
- The SQLite database is a file, not a network service.

### T4: XSS (4b)

- Tool descriptions, upstream output and error messages are untrusted. The UI renders them as
  text only: React escaping, no `dangerouslySetInnerHTML`, no Markdown rendering.
- A strict CSP is applied: `script-src 'self'`, `object-src 'none'`, `base-uri 'none'`,
  `frame-ancestors 'none'`. Responses also carry `nosniff`.
- Since 4a, every response carries `default-src 'none'`, `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer` and COOP/CORP.

### T5: CSRF (4b)

- A synchronizer token tied to the session, sent in a header.
- `Origin` / `Sec-Fetch-Site` must match the public URL, on login too.
- The management API sends no CORS headers. The gateway needs an `Authorization` header that
  browsers will not send cross-origin without a preflight that Studio never approves.

### T6: Session fixation and theft (4b)

- A new session id at login; only its SHA-256 is stored.
- The cookie is HttpOnly and SameSite=Lax. Over https it is also `Secure` with the `__Host-`
  prefix.
- Sessions have idle and absolute timeouts, and logout deletes them. `reset-admin` ends all
  sessions of the admin (4a).

### T7: Login brute force (4b)

- Failed logins are limited per IP and per account, with growing delays.
- The error message is the same whether or not the account exists.
- Passwords are hashed with scrypt (N=2^15, r=8, p=1) and compared in constant time.

### T8: API key leakage (4a; management 4c)

- Keys are `kvn_` plus 32 random bytes and are shown once. Only the SHA-256 and a short prefix
  are stored.
- A key belongs to one server. Missing, unknown, revoked and other-server keys all get the same
  401 body, so callers cannot learn which servers exist.
- The key never reaches tools, logs or upstreams: tools see the key id.
- There is a per-key rate limit.
- Revocation takes effect on the next request and also ends the key's open event streams
  (subscriptions). Deleting a server ends all of its streams.

### T9: Taking over a fresh installation (4a)

- Until an admin exists, Studio listens on `127.0.0.1` only, whatever `KERVAN_STUDIO_HOST`
  says. It prints a single-use setup token (30 minutes; a restart issues a new one and
  invalidates the old one). Only the token's hash is stored.
- `kervan-studio reset-admin` (operator shell) sets a new password and ends the admin's
  sessions. It is recorded in the audit log, without the password.

### T10: Tenant and server isolation (4a)

- Repository functions take a `WorkspaceScope` and filter by it.
  - Tests use two workspaces and pass one workspace's scope with the other's ids: nothing is
    read, changed or deleted.
  - The only unscoped lookups are by credential hash (API key, setup token).
- The gateway checks twice that the URL's server matches the key's server: authentication, then
  resolution. Each layer is tested on its own.
- Each server has its own registry, SDK handler and notification channel, so `list_changed`
  never crosses servers (tested in both protocol eras).
- An unpublished or deleted server returns a fixed 404 or 401 that does not echo the server.

### T11: Prompt injection through upstream output (4a, residual)

- Spec tools must `select` fields (or opt into `raw: true`), so only chosen fields reach the
  model.
- The playground (4b) shows output as text.
- Content inside a selected field can still carry instructions. This is documented as a
  residual risk.

### T12: Resource exhaustion (4a)

- Request limits:
  - per client IP across Studio. IPv6 clients are counted per /64, since one host usually
    holds a whole /64;
  - per API key at the gateway;
  - the gateway's request body is limited to 1 MiB;
  - JSON-RPC batches are refused, so one request is at most one call against the per-key
    limit.
- Spec tools keep the runtime limits: timeouts, response sizes, per-tool rate limits and the DNS
  lookup cap.

### T13: Repudiation (4a; more events in 4b/4c)

- The audit log is append-only (database triggers refuse `UPDATE` and `DELETE`).
- Events recorded:
  - server create and delete;
  - publish (including rollback), with the version and the previous version;
  - API key create and revoke;
  - password resets.
- Login, logout and secret changes are added in 4b/4c.
- Details hold names, ids and counts, never values.

### T14: Master key and data at rest (4c; file permissions 4a)

- Secrets are encrypted with AES-256-GCM using a key from `KERVAN_STUDIO_MASTER_KEY` (or a
  `KeyProvider`). Studio refuses to start without one. The workspace, server and secret ids are
  bound as associated data, so a ciphertext cannot be moved to another row. A key version
  allows rotation.
- The database:
  - POSIX: the data directory is 0700 and the database files 0600 (also tightened on an
    existing database).
  - Windows: the files inherit the directory's ACL, so keep the data directory in a private
    location.
  - Opened in WAL mode with a busy timeout and foreign keys on.
  - Studio refuses to start when a migration fails or when the database was written by a
    newer version.
- Spec versions are immutable. Triggers refuse:
  - `UPDATE`;
  - an insert over an existing id (`INSERT OR REPLACE`);
  - `DELETE`, unless the server itself is deleted.
- Audit events: triggers refuse `UPDATE`, `DELETE` and inserts over an existing id.

## Reverse proxies

- `KERVAN_STUDIO_TRUST_PROXY=N` says how many proxies append to `X-Forwarded-For`. The client IP
  is the address the outermost trusted proxy saw; entries further left are client-written and
  ignored.
- With the default `0`, the header is ignored entirely.
- **When `KERVAN_STUDIO_TRUST_PROXY` is on, Studio must be reachable only through the
  proxy.** Bind Studio to loopback or a private interface that only the proxy can reach, and
  block its port from everywhere else. Otherwise a client that connects to Studio directly can
  write any client IP into `X-Forwarded-For`. That defeats the per-IP limit, puts false addresses
  in the audit log, and will affect login throttling in 4b.
- The proxy must pass the original `Host` header, because Studio accepts only the public URL's
  host name.

## Known limits

- **Gateway authentication uses per-server API keys.** OAuth 2.1 with protected resource
  metadata (RFC 9728), as the MCP authorization spec describes, is future work.
- **Single process.** Registries, rate limits and caches live in memory. Several Studio
  instances would need a shared store and pub/sub for publish notifications.
- **A bound host's own features** (for example an API that can create webhooks to arbitrary
  URLs) can still move data. Bind secrets to hosts that cannot be used this way.
- **Regular expressions in specs' JSON Schemas** may be slow (ReDoS), as in the framework.
- **Windows file permissions** are not set by Studio (see T14).
- **Studio's own addresses are resolved once**, from the public URL at startup. Put any other
  addresses that front Studio in `KERVAN_STUDIO_DENY_NETWORK`: more load balancer or CDN
  addresses, or new ones after a DNS change.
- **Loopback-only setup does not help when a reverse proxy runs on the same machine**, because
  the proxy forwards to loopback. The single-use setup token is what protects a fresh install.
- **Encodings the vault does not know.** If a bound upstream reflects a secret in another
  encoding (for example base64 or HTML entities), it is not redacted. Bind secrets to APIs you
  trust not to echo them.
