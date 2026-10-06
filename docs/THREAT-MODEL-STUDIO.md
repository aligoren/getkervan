# Kervan Studio threat model

Kervan Studio is a self-hosted web app: people write `kervan.yaml` specs in a browser, publish
them, and MCP clients use them through Studio's gateway at `/s/{serverId}/mcp`. This document
lists who interacts with Studio, what must be protected, the attacks we design against, and how
each one is mitigated and tested.

Status legend:
- **Implemented:** **4a** (gateway, data model, framework extensions) and **4b** (management API,
  web UI, playground).
- **Planned:** **4c** (encrypted vault, version history, API key management, logs). It is listed
  so the design is reviewed as a whole.

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

- The following are untrusted, and the UI renders them as text children only:
  - tool names, titles and descriptions;
  - tool output and upstream text;
  - spec issues and error messages;
  - server names and the raw playground traffic.
- None of that is ever rendered as HTML, Markdown, a link or an image. Non-text tool content
  (images) is described, not displayed.
- jsdom tests feed seven payloads into every component that shows untrusted text (`<img
  onerror>`, `<script>`, `<iframe>`, `<svg onload>`, Markdown and `javascript:` links). They check
  that no element, event-handler attribute or `javascript:` URL appears.
- A source scan forbids `dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`,
  `document.write`, `eval`, `new Function` and web storage in the UI code. Biome forbids
  `dangerouslySetInnerHTML` too.
- Monaco shows marker messages as plain text.
- **CSP of the UI:**
  - `default-src 'self'; script-src 'self'` (no inline or eval);
  - `style-src 'self' 'unsafe-inline'` (Monaco sets inline styles);
  - `worker-src 'self' blob:`, `connect-src 'self'`;
  - `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'self'`.

  A live check in a real browser (Playwright) found no CSP violation.
- API and gateway responses keep `default-src 'none'`, plus `nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer` and COOP/CORP.

### T5: CSRF (4b)

- Every state-changing API request needs all of the following, and setup and login need all but
  the token:
  - `Origin` exactly equal to the public URL's origin. A missing Origin, `null`, another port and
    plain http are all refused.
  - `Sec-Fetch-Site: same-origin` when the browser sends that header.
  - `Content-Type: application/json`, so plain HTML forms cannot post.
  - The session's CSRF token in `X-CSRF-Token`, compared in constant time. The token is the
    SHA-256 of the secret session id, so only that session's holder can know it.
- The management API sends no CORS headers.
- The gateway needs an `Authorization` header, which browsers won't send cross-origin without
  a preflight that Studio never approves.

### T6: Session fixation and theft (4b)

- Every login issues a new session id, and a session id the browser brought along is
  deleted. Only the SHA-256 of the id is stored.
- The cookie is HttpOnly, SameSite=Lax and `Path=/`, with no `Domain`. Over https it also gets
  `Secure` and the `__Host-` prefix.
- Sessions end after 2 hours idle and after 24 hours in any case. An expired session is deleted
  when seen, and logout (which also needs the CSRF token) deletes the session.
- `reset-admin` ends all of the admin's sessions.
- The CSRF token lives in page memory only, never in web storage.

### T7: Login brute force (4b)

- Failed logins are counted per account and per client IP:
  - 5 failures for an account, or 20 from an IP, within 15 minutes lock it for 15 minutes (429
    with `Retry-After`), even for the right password;
  - unknown accounts lock the same way, so the lock reveals nothing;
  - setup-token guesses are limited per IP too.
- A wrong password and an unknown account get the same answer. An unknown account still costs
  a password check against a dummy hash.
- Passwords need at least 12 characters, are hashed with scrypt (N=2^15, r=8, p=1) and are
  compared in constant time.
- Login successes and failures go to the audit log, with the client IP and never a password.
- Roles: members write, validate and publish specs and use the playground. Only admins manage
  users, delete servers and read the audit log (and, in 4c, secrets and keys). Tests check
  every admin-only endpoint with a member session.

### T8: API key leakage (4a; management 4c)

- Keys are `kvn_` plus 32 random bytes and are shown once. Only the SHA-256 and a short prefix
  are stored.
- A key belongs to one server. Missing, unknown, revoked and other-server keys all get the same
  401 body, so callers cannot learn which servers exist.
- The key never reaches tools, logs or upstreams: tools see the key id.
- There is a per-key rate limit.
- Revocation takes effect on the next request and also ends the key's open event streams
  (subscriptions). Deleting a server ends all of its streams.

### T8b: Playground tokens (4b)

- The playground's browser client calls the gateway with a token, not a cookie: `kvp_` plus a
  payload signed with HMAC-SHA256. The payload holds the workspace, server, version, user and
  expiry.
- The signing key exists only in the Studio process, so a restart invalidates every token.
  Tokens last 15 minutes.
- A token works only on its own server and version, including drafts. Forged, tampered, expired
  and other-server tokens all get the same 401.
- A draft loads with the same secret store, host bindings and network policy as a published
  version, so a member cannot use the playground to send a secret anywhere publishing would
  refuse.
- Drafts unused for 15 minutes are unloaded.
- The token is never written to the page or the raw traffic log.

### T9: Taking over a fresh installation (4a)

- Until an admin exists, Studio listens on `127.0.0.1` only, whatever `KERVAN_STUDIO_HOST`
  says. It prints a single-use setup token (30 minutes; a restart issues a new one and
  invalidates the old one). Only the token's hash is stored.
- `kervan-studio reset-admin` (operator shell) sets a new password and ends the admin's
  sessions. It is recorded in the audit log, without the password.
- Setup in the browser (4b) consumes the token in the same transaction that creates the admin.
  It is refused once any admin exists. Only then does Studio also listen on
  `KERVAN_STUDIO_HOST`.

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
