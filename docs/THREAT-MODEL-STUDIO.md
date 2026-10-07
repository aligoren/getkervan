# Kervan Studio threat model

Kervan Studio is a self-hosted web app: people write `kervan.yaml` specs in a browser, publish
them, and MCP clients use them through Studio's gateway at `/s/{serverId}/mcp`. This document
lists who interacts with Studio, what must be protected, the attacks we design against, and how
each one is mitigated and tested.

Status: all three parts are implemented:
- **4a:** gateway, data model and framework extensions;
- **4b:** management API, web UI and playground;
- **4c:** encrypted vault, version history, API key management and call logs.

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

Before the first release, three more independent reviewers (authentication and authorization;
gateway and spec runtime; user-supplied text, terminals and supply chain) each worked from a
fresh context and proved findings with failing tests. Their fixes are marked "release review"
below; their tests are kept in the `test/review` folders of `apps/studio`, `apps/studio/web`,
`packages/spec-runtime` and `packages/cli`. `docs/TEXT-SURFACES.md` maps every user-supplied
string to the places it is shown.

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
- **Numbers too** (release review): a number that holds a secret becomes the redaction marker,
  so `select` arithmetic and comparisons have nothing to work on, and structured output and call
  logs never hold it. JSON is checked as the upstream wrote it, so a long numeric secret that
  parsing would round is caught as well.
- Tool results and `ToolError` messages are then redacted again, in raw, URL-encoded,
  form-encoded and JSON-escaped forms. Studio's logger redacts every known value from messages
  and serialized data.
- A `raw: true` JSON body is also decoded and redacted value by value, because JSON can spell a
  string in ways text redaction does not list (`\/`, `\u0041`). If that finds a secret, the
  redacted JSON is returned re-encoded instead of the upstream's text.
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
    (even with `--allow-private-network`) refuses them too. Also in the IPv6 forms that carry an
    IPv4 address (release review): NAT64 (`64:ff9b::/96`, and every RFC 6052 position in the
    local-use `64:ff9b:1::/48`), 6to4, IPv4-compatible and SIIT;
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
- **Deactivating a user** (admins only) deletes their sessions in the same transaction, which
  also ends their playground tokens. Sign-in, session lookup and the playground's session check
  each refuse a deactivated user on their own, so a session left behind is still refused. A
  deactivated user's correct password gets the same answer as a wrong one. Their open
  playground streams are ended as well. The last active admin cannot be deactivated;
  deactivation and reactivation are audited.
- Before deactivating, the admin sees the active API keys the user created and can revoke them
  in the same transaction. Each revoked key gets its own audit event (reason `user.disable`),
  the `user.disable` event counts them, and their open streams are closed.
- The web UI returns to the sign-in page as soon as a request is refused because the session
  ended (signed out elsewhere, timed out or deactivated).
- **Changing one's own password** needs the current password and ends every other session of
  the user (and so their playground tokens); the session that made the change stays.
- **An admin's password reset** needs the admin's own password, ends all of the user's
  sessions, and sets `must_change_password`. Until the user picks a new password, the API
  answers 403 (`password_change_required`) to everything except the session check, the profile,
  the password change and sign-out; hiding the rest in the UI is not what enforces it. A
  generated temporary password is in the reset response only; a chosen one is never echoed.
- **Last active admin:** deactivation and demotion are checked in the same SQLite transaction as
  the change, so two concurrent requests cannot both remove an admin (tested). There is no way to
  delete a user.
- **Every write transaction begins with BEGIN IMMEDIATE** (`writeTransaction`): it takes the
  write lock before the check, so a second writer, in this process or another Studio process on
  the same database file, waits and then reads the new state instead of a stale snapshot (tested
  with two connections). This relies on better-sqlite3 being synchronous; moving to an
  asynchronous driver means re-evaluating every check-then-write.
- **A role change, and adding a user,** need the admin's own password, checked by the server
  and throttled like a sign-in (as for a password reset): a stolen admin session alone cannot
  make a new admin, or an account with a password the thief knows (adding a user: release
  review).
- **Checks that wait on a password hash are made again when writing** (release review). Requests
  check a password or a role, then wait on scrypt; the write that follows must not act on what
  changed meanwhile (tested with a pause inside scrypt):
  - a sign-in starts its session only if the password it checked is still the user's and the
    user is still active, in the same transaction: a sign-in in flight does not outlive a
    password change, a reset or a deactivation;
  - changing one's own password writes only if the stored hash is still the one checked and the
    session still lives (compare-and-set): it cannot undo an admin's reset;
  - every admin write (adding a user, role, email, password reset, deactivation) checks in its
    transaction that the admin making it is still an active admin.
- **Members** reach only their own profile, which has no user id in its path, and its body is
  strict: a `role`, `email` or `id` field is refused (400), not ignored. Every endpoint about
  another user is admin-only (IDOR tests), and sessions are ended by an opaque reference that
  only matches the owner's sessions.
- Session listings never contain a session id or its hash.
- The CSRF token lives in page memory only, never in web storage.

### T7: Login brute force (4b)

- Failed logins are counted per account and per client IP (IPv6: per /64):
  - 5 failures for an account, or 20 from an IP, within 15 minutes lock it for 15 minutes (429
    with `Retry-After`), even for the right password. The window slides (release review): no
    more than the limit gets through in any 15 minutes, also across what a fixed window's
    boundary would be;
  - a refused attempt adds no counter, so a locked IP trying new account names does not grow
    the throttle's memory;
  - an attempt reserves its place before the password check, so a burst of concurrent guesses
    gets no more checks than the limit allows (tested with 30 at once);
  - unknown accounts lock the same way, so the lock reveals nothing;
  - setup-token guesses are counted per IP only, in their own namespace: nobody can lock setup
    for the operator, and failed logins for an account named "setup" do not count. The token
    is checked before the password is hashed.
- A wrong password and an unknown account get the same answer. An unknown account still costs
  a password check against a dummy hash.
- Passwords need at least 12 characters, are hashed with scrypt (N=2^15, r=8, p=1) and are
  compared in constant time.
- Login successes and failures go to the audit log, with the client IP and never a password.
- A wrong current password on a password change, and a wrong admin password on a reset, count
  against the same account and IP limits as failed logins (the same lock).
- Emails are unique per workspace, compared case-insensitively. An admin changing an email gets
  a clear "already used" error; the sign-in page still answers the same for known and unknown
  emails.
- Role, email, profile, password changes and resets, and session sign-outs are audited with who
  did what to whom; never a password.
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
  refuse. A test uses one draft for both: publishing refuses its tools that send the secret to
  another host and to another port of the bound host, and the playground refuses the same calls
  without sending anything.
- Drafts unused for 15 minutes are unloaded.
- The token is never written to the page or the raw traffic log.
- A token is bound to the session that asked for it. The gateway checks that this session is
  still live, so signing out, an idle or absolute session timeout and `reset-admin` end the
  token at once. An event stream it opened ends when the token expires.
- At most 32 drafts are loaded; loading another unloads the least recently used.

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
- A gateway request with an `Origin` header must come from Studio's exact public origin
  (scheme, host and port), so a page on another port or scheme of the same host cannot use the
  playground's same-origin access. MCP clients outside a browser send no `Origin`.

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
    limit;
  - one API key (or one user's playground) holds at most 32 event streams open.
- Ended sessions and call logs past their retention are deleted at startup and hourly.
- Spec tools keep the runtime limits: timeouts, response sizes, per-tool rate limits and the DNS
  lookup cap.
- A spec's `select` expression runs in a separate process: see T19.

### T17: Misleading text (names, emails, failed sign-ins)

- Text people type and others see may not hide anything (`apps/studio/src/display-text.ts`):
  controls including line breaks and NUL, bidi controls, zero-width and other format characters,
  and blank-looking letters.
  - Refused (400, naming the code point) where people choose the text and can fix it: emails
    (setup, adding a user, changing an email), display names, server names, API key names. Slugs
    and secret names were already plain ASCII.
  - Escaped visibly (a backslash, "u" and the code point; backslashes doubled) where Studio must
    keep what was sent: the email of a failed sign-in in the audit log. The 320-character limit
    applies after escaping, ending in "…".
- A display name may not read as a privileged label ("admin", "system", "Kervan Studio", ...),
  compared after folding case, width, accents, spaces, invisible characters and common Cyrillic,
  Greek and Turkish lookalikes. It may not be an email at all (anything with "@" after folding):
  refusing only other users' emails told members which accounts exist (release review). An
  email may not read as another user's display name either (names saved before this rule). The
  lookalike table is not exhaustive.
- Spec text (names, titles, descriptions) follows the same idea: see T20.
- A failed sign-in looks the same whether or not the account exists: the same answer and lock-out,
  the same audit row (no user id either way), and the same work: an unknown email is checked
  against a dummy hash computed when the API starts, so even the first attempt is not faster or
  slower (tested as "within 10x", not a fixed time).
- No source file contains invisible or text-direction characters (a repository test).

### T13: Repudiation (4a–4c)

- The audit log is append-only (database triggers refuse `UPDATE` and `DELETE`). Admins can read
  it in the UI.
- Events recorded (`apps/studio/test/audit-catalogue.test.ts` triggers each one through the API
  and pins the list):
  - `studio.setup`; `login.success` and `login.failure` (with the client IP); `logout`;
    `session.end` and `session.end_others` (sessions a user signed out);
  - `user.create`, `user.role`, `user.email`, `user.password_reset` (also by
    `kervan-studio reset-admin`), `user.password_change`, `user.profile`, `user.theme` (only
    when it changes), `user.disable` and `user.enable`;
  - `server.create`, `server.delete`, `server.settings` (the call-log setting);
  - `server.publish` and `server.rollback`, with the version and the previous version;
  - `server.publish_refused` (for example a spec that would send a secret to an unbound host),
    with who tried and how many problems were found;
  - `secret.create`, `secret.rotate`, `secret.hosts` and `secret.delete` (with the tools that
    used a deleted one);
  - `api_key.create` and `api_key.revoke` (also for each key revoked with a deactivation).
- Not recorded: saving a spec version (versions are immutable and keep their author) and
  playground use (call logs record the calls).
- Details hold names, ids, hosts and counts, never values, keys or passwords. The catalogue test
  checks every stored row and the audit page for each password, secret value, API key, setup
  token and session used along the way.

### T15: Call logs (4c)

- Every gateway call is logged with tool, status, duration and version: published, or the
  playground's draft.
- Arguments and results are logged only when an admin turns it on for a server. Even then, they
  are redacted with that server's vault and cut to 4 KiB. A secret a client sends as an argument
  is redacted too, once the server has used it.
- Members see call metadata only; payloads are for admins.
- Logs are deleted after `KERVAN_STUDIO_LOG_RETENTION_DAYS` (30 by default), at startup and then
  hourly.

### T16: Secret lifecycle (4c)

- **Admin-only and write-only.** Only admins create, rotate, rebind and delete secrets. The API
  never returns a value; listings show names, hosts, the update time and which tools of the
  published version use the secret.
- **Changes apply at the next call.**
  - Rotation: the old value stays redacted wherever the server saw it.
  - A narrowed binding: the call is refused before anything is sent.
- **Deleting a secret the published version uses** is refused with the list of tools that use
  it, unless confirmed. Afterwards those tools fail with "Secret X is not configured for
  host:port", and nothing is sent.

### T18: Taking a server offline

- Anyone who may publish (any signed-in user, with the CSRF token) can disable a server and enable
  it again; both are audited (`server.disable`, `server.enable`), only when the state changes.
- Disabled, the gateway answers 404 for every request, exactly as for an unknown server: a valid
  key, the published version and playground tokens alike. The check is made on every request (and
  again when the published version loads). Open streams and subscriptions close at once,
  playground drafts are dropped, and new playground tokens are refused.
- Nothing is deleted: versions, secrets, keys and call logs stay, and enabling serves the
  published version again with the same keys. Publishing while disabled does not serve anything.

### T19: Expensive `select` expressions (release review)

- A `select` is at most 1,000 characters, but the JMESPath dialect can build data out of nothing
  (`pad_left('a', 500000000)` is one huge string; `split`, `replace` and `join` multiply) and
  `map` nests over the whole document (`$`). A few dozen characters could allocate gigabytes or
  run for minutes, synchronously: every server, the management API and the UI would stall, and
  a large enough allocation ends the process. In Studio a member could do this from the
  playground, and any key holder could repeat it once published.
- Expressions run in a separate process (two at most, started when first needed, never keeping
  Studio alive when idle) with its own heap limit (256 MB):
  - it is stopped when the tool's `timeoutMs` runs out (waiting included), and the call fails;
  - running out of memory ends only that process; the call fails, and the next call gets a new
    one;
  - only the selected JSON comes back, cut to the tool's output limit.
- Tests: a 34-character expression that used to end the process, a 1,000^3 nested `map`, and
  gradual growth past the heap limit, each in a child process; the process is not kept alive.
- Limit: one slow expression holds one of the two processes until its timeout, so calls of other
  tools may wait (their wait counts against their own timeout). Rate limits bound how often a
  key can do this.

### T20: Text in specs, and terminals (release review)

- Spec text that people and the model read may not hide anything: the server's name, version and
  description, tool titles and descriptions, annotation titles, and every `title` and
  `description` inside input and output schemas. A spec with control characters (other than line
  feed and tab in descriptions), bidi controls, zero-width, tag or other format characters (other
  than ZWNJ and ZWJ, which scripts and emoji need), separators or blank-looking letters does not
  load; the issue names the field and the code point. This is the framework's rule, so `kervan
  run`, Studio's validation and publishing, and the playground all refuse it.
- Studio's UI shows such characters, wherever untrusted text appears (tool lists, results, spec
  issues, the version diff, call log payloads, raw playground traffic, error messages), as marked
  escapes (a backslash, "u" and the code point), never as themselves. Monaco marks them in the
  editor.
- Spec issues quote unknown field names with every such character (line breaks too) spelled out.
- The CLI writes every line to the terminal through one filter: control characters other than
  line feed and tab (ESC, CR, BEL, C1), bidi and format characters are printed as visible
  escapes. A spec, a tool's description or result, or a dev server's own output cannot retitle
  the terminal, rewrite or hide lines, set the clipboard or show a lying link.

### T21: DNS rebinding and browser origins (release review)

- `Host` (DNS rebinding: an attacker's name that resolves to Studio's address) is checked on
  every path by Studio's HTTP layer, and again inside the gateway by the SDK: only the public
  URL's host name (for a loopback URL: `127.0.0.1`, `localhost`, `[::1]`) is accepted.
- `Origin`, when present, must be the public URL's exact origin (scheme, host and port) at the
  gateway (403 otherwise); the SDK's host-name check stays behind it as a second layer. MCP
  clients outside a browser send no `Origin` and only need a valid key.
- Tests send real requests with the `Host` and `Origin` an attack would use, for a public and a
  local Studio, and every layer is mutation-tested on its own.
- The framework's `serveHttp` (and `serve()`, which reads `HOST`) refuses to listen beyond
  loopback without `allowedHosts`, like `kervan run` without `--allowed-host`: a container's
  `HOST=0.0.0.0` no longer opens a generated project to the network without a `Host` check.

### T14: Master key and data at rest (4c; file permissions 4a)

- Secrets are encrypted with AES-256-GCM, a fresh 96-bit IV per write, under a key from
  `KERVAN_STUDIO_MASTER_KEY` (base64 of 32 bytes, or a `KeyProvider`).
- Each row binds its workspace, server and secret name as associated data. A ciphertext copied
  to another row fails authentication (tested).
- Studio refuses to start in two cases (both tested):
  - without a master key: it prints how to make one;
  - when any stored secret does not decrypt with the configured keys.
- **Rotation:** the new key becomes `KERVAN_STUDIO_MASTER_KEY` (`2:...`), and the old one moves to
  `KERVAN_STUDIO_PREVIOUS_MASTER_KEYS` (`1:...`). On the next start, Studio re-encrypts every row
  under the new key; after that the old key can be removed.
- The master key never goes into the database. Back it up separately: a database backup alone
  does not reveal secrets, and cannot restore them either.
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
- The data directory stays out of git: a directory Studio creates gets a `.gitignore` that
  ignores everything in it (an existing `.gitignore`, or a directory Studio did not create, is
  left alone), the repository ignores `.kervan-studio/`, and Studio warns at start when the
  database, or its `-wal` or `-shm` file, is inside a git working tree and tracked or not
  ignored (a rule like `*.db` covers the database but not those; release review).

## Reverse proxies

- `KERVAN_STUDIO_TRUST_PROXY=N` says how many proxies append to `X-Forwarded-For`. The client IP
  is the address the outermost trusted proxy saw; entries further left are client-written and
  ignored.
- With the default `0`, the header is ignored entirely.
- **When `KERVAN_STUDIO_TRUST_PROXY` is on, Studio must be reachable only through the
  proxy.** Bind Studio to loopback or a private interface that only the proxy can reach, and
  block its port from everywhere else. Otherwise a client that connects to Studio directly can
  write any client IP into `X-Forwarded-For`. That defeats the per-IP limit and the login
  throttle, and puts false addresses in the audit log.
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
- **Users are deactivated, not deleted**, so their audit records keep pointing at them. API
  keys a deactivated user created stay valid if the admin unchecks "also revoke": keys belong to
  servers, not users.
- **Users cannot change their own email.** It is the sign-in identifier and Studio does not
  verify email addresses, so only an admin changes it.
- **A password change ends the user's open playground streams in every session**, including the
  current one (streams are tracked per user); the current session's tokens stay valid, so the
  playground reconnects.
- **Unbounded version history.** Every save is kept; there is no cap or pruning per server.
  Members are trusted not to fill the disk.
- **Members can read bindings** (secret names and hosts, never values) through the export, so
  they can write specs that use them.
- **An open playground stream survives sign-out** until its token expires (at most 15
  minutes); new requests with the token are refused at once. Deactivating the user ends their
  open streams too.
- **Accepted after the release review** (each considered, none proven exploitable):
  - an account lock lives in memory: after `reset-admin` (another process), a locked admin waits
    out the lock or restarts Studio;
  - with a reverse proxy on the same machine and `KERVAN_STUDIO_TRUST_PROXY=0`, every client is
    127.0.0.1 to Studio, so failed setup guesses from anyone count together (set the proxy count);
  - changing one's own password keeps the current session (the others end): if that very cookie
    was stolen, sign out and in again;
  - the exported `kervan.yaml` keeps a member's comments, including a `yaml-language-server`
    schema line an editor might follow;
  - the `claude mcp add` command Studio shows puts the key in shell history;
  - a tool whose name server never answers holds one of the process-wide DNS lookup slots until
    its timeout; members choose their own (bounded) timeouts and response sizes;
  - `raw: true` JSON with duplicate keys: a value `JSON.parse` drops is not checked value by
    value (text redaction still runs);
  - a path value like `../admin` is sent percent-encoded (`..%2Fadmin`); an upstream that decodes
    `%2F` before routing could treat it as a path.
- **Encodings the vault does not know.** If a bound upstream reflects a secret in another
  encoding (for example base64 or HTML entities), it is not redacted. Bind secrets to APIs you
  trust not to echo them.
