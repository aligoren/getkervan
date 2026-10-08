# Review notes: unproven suspicions and accepted risks

Everything the security reviews raised but did not prove with a failing test, and every risk
accepted on purpose, in one place. Read it before a release (see `docs/RELEASING.md`) and when
deciding what to harden next.

Proven findings are not listed here: each was fixed, with a test and a mutation, and is
described in `docs/THREAT-MODEL-STUDIO.md`.

## Sources

- **Release review** (October 2026): three independent reviewers, each with a fresh context and
  one area: (A) authentication and authorization, (B) gateway and spec runtime, (C) user-supplied
  text, terminals and supply chain. The lists below are taken from their final reports' "plausible
  but not proven" sections.
- **Hardening round** right after it (select process sandbox, session renewal, connect commands,
  release files): what was found while doing it but not tested or not solved.
- **Second hardening round** (October 2026): `create-admin`, the small items below, and a
  targeted independent review of the code added in the two hardening rounds.
- **Final round before the feature freeze** (October 2026): one Node.js range for every runtime
  package, authorization checked again at every write, the password change and session renewal
  in one transaction, quoted URLs in the connect commands, the User-Agent shown with visible
  escapes. What it closed is marked "final round" below; what stays open is listed at the end.
- **Website review** (October 2026): one independent reviewer with a fresh context over the Hugo
  site, its scripts and the documentation it shows. See "Website" below.
- **Threat model**, "Known limits" (and T19's limit): the accepted risks, including those from
  earlier phases.
- **Not available:** the independent reviews at the end of phases 4a and 4c also had findings
  that were fixed (recorded in the threat model), but **no record** of what else
  they suspected without proof was kept. Nothing from them is listed below.

Status: **open** (nothing done yet), **accepted** (a known limit, with the reason),
**partly addressed**, **fixed later** (proven and fixed after the report), **resolved** (changed
so the suspicion no longer applies, with a test and a mutation), **verified** (tested and found
not to be a problem; the test stays).

## Release review: suspicions not proven

### Reviewer A: authentication and authorization

| Suspicion | Why not proven | Status and next step |
| --- | --- | --- |
| **An account lock outlives `reset-admin`.** Locks live in Studio's memory; `reset-admin` runs in another process, so a locked admin stays locked after a reset. | It needs two processes and a lock in progress; no test was written. | **Accepted** (Known limits): wait out the 15 minutes or restart Studio. Next step if it bites: `reset-admin` could tell the running Studio, or locks could live in the database. |
| **The session id is not renewed when one changes one's own password, or when promoted to admin.** If the victim's own cookie was stolen, the thief stays on that session. | A design observation, not a test. | **Resolved.** A password change renews the session (new cookie and CSRF token). A role change, either way, ends all of the user's sessions and playground tokens and their open playground streams; they sign in again, and the audit event counts the sessions (`apps/studio/test/hardening.test.ts`, "a role change"; mutation-tested). |
| **Setup can be locked behind a reverse proxy on the same machine.** With `KERVAN_STUDIO_TRUST_PROXY=0`, every client is 127.0.0.1 to Studio, so anyone's wrong setup guesses count together (20 lock it). Contradicts "nobody can lock setup for the operator" for that deployment. | It depends on the deployment; the throttle itself works as designed. | **Accepted** (Known limits): set `KERVAN_STUDIO_TRUST_PROXY` to the number of proxies. |
| **The throttle's map can grow without bound:** a locked IP trying new account names added a counter per name. | Reported as plausible. | **Fixed later:** a refused attempt adds no counter (test "adds no counters for attempts it refuses", mutation-tested). |
| **Playground token signatures are decoded leniently:** `Buffer.from(signature, "base64url")` accepts several spellings of the same signature (malleability, not forgery). | No way to forge a token was found; only different spellings of a valid one. | **Resolved.** Only the canonical spelling is accepted (re-encoding must give the same text); a twin differing in the unused bits, padding and stray characters are refused (`hardening.test.ts`, "playground token signatures"; mutation-tested). |

### Reviewer B: gateway and spec runtime

| Suspicion | Why not proven | Status and next step |
| --- | --- | --- |
| **Encoded traversal in path values:** an input `../admin` is sent as `..%2Fadmin`; an upstream or proxy that decodes `%2F` before routing (some nginx rules) could treat it as traversal. Kervan refuses only `.`, `..` and empty values. | It depends on the upstream's server; encoding slashes inside a value is deliberate (tested). | **Accepted** (Known limits). Possible next step: refuse values containing `../` or `..\` in path positions. |
| **DNS lookup slots can be used up from one server:** only 2 lookups run at once in the whole process; a tool whose name server never answers keeps slots busy until its timeout, and other servers' tools wait. | Needs a DNS server that never answers; not built into the tests. | **Accepted** (Known limits). Next step if needed: lookup slots per server, or a shorter DNS deadline than the tool's timeout. |
| **Memory from member-set limits:** a member can set `concurrency: 1000` with `maxResponseBytes: 50 MB` on a tool. | Not demonstrated; the spec limits are bounded, but their product is large. | **Partly accepted** (Known limits mention member-chosen bounded limits). Next step: Studio-wide lower caps on concurrency and response size per server. |
| **Load churn from the playground:** cycling through more than 32 drafts forces a full `loadSpec` on every request (up to 600 per minute per user). | Not measured. | **Open.** Next step: measure; if it matters, a per-user limit on draft loads. |
| **Duplicate JSON keys in `raw: true` output:** if the upstream sends a key twice with an escaped secret in the copy `JSON.parse` drops, the value-by-value redaction does not see it (text redaction still runs). | Needs an upstream that cooperates with the attack. | **Accepted** (Known limits). |
| **Studio's logger formatting:** `inspect` has its own escaping and cuts strings at 10,000 characters, which could break redaction for secrets with unusual characters or very long secrets, if they ever reached logged data. | No path that logs a secret was found. | **Fixed later (proven).** A test with eleven unusual secrets in every position (message, string, nested value, key, error message, cause, error field, Map, Set, long string, bytes) failed for nine of them: longer than 10,000 characters (a prefix came out), ESC, NUL, DEL, C1 and other controls (`\x1B` vs JSON's `\u001b`), all three quote marks (`\'`), and line breaks inside a key. Now the data is redacted string by string before `inspect`, and the line again after (`apps/studio/test/logger-redaction.test.ts`; mutation-tested). Found on the way: a secret with an unpaired surrogate made the framework's vault throw `URIError` when registering it; such values are now refused with a clear error, in Studio when set and in the vault. |

### Reviewer C: user-supplied text, terminals and supply chain

| Suspicion | Why not proven | Status and next step |
| --- | --- | --- |
| **Windows data-directory ACL:** the default `.kervan-studio` lives in the working directory; on a non-system drive `Authenticated Users` may have modify rights, so another local user could read or change the database (and bypass its triggers). | Seen with `icacls` on the reviewer's machine; it depends on the drive's ACL. | **Accepted** (Known limits, T14: Studio does not set Windows permissions). Next step: warn at start when the folder's ACL is broad. |
| **`kervan studio` forwarding** walks up to the file system root and imports any ancestor `package.json` named `@kervan/studio`, with no containment check on its `./cli` path. | Comparable to Node's own module resolution; matters only on shared machines. | **Partly addressed.** The `./cli` module must be inside the package that names it (`..`, absolute and outside paths are refused and the search goes on; `packages/cli/test/studio.test.ts`; mutation-tested). The walk up to the root stays, as in Node's own resolution: a `node_modules/@kervan/studio` in a parent folder someone else controls is still used. Next step if needed: stop at the nearest `package.json`. |
| **The exported `kervan.yaml` keeps a member's comments**, including a `yaml-language-server: $schema=https://...` line an editor would follow (and show its hovers). | Editor behavior, outside Kervan. | **Accepted** (Known limits): the export is the saved text, byte for byte. |
| **The `git` start-up check runs `git` in the data directory:** inside an untrusted worktree (an extracted archive with its own `.git/config` and `core.fsmonitor`), git could run commands. | Needs an attacker-prepared directory; git's `safe.directory` check already refuses repositories owned by another user. | **Fixed later (proven).** With a repository whose `core.fsmonitor` writes a file, `ls-files` and `check-ignore` ran it. Now git runs with program-running settings off on the command line (`core.fsmonitor`, `core.hooksPath`, askpass, credential helpers, external diff, protocols), no system or global config (so no `safe.directory` exception), and no `GIT_*` variable (`hardening.test.ts`, "the start-up git check"; both mutation-tested). Git for Windows refuses Windows' own null device as a config path, so `/dev/null` is used everywhere. |
| **The connect command puts the key in shell history.** | A usage observation. | **Partly addressed:** Studio also offers bash/zsh and PowerShell commands that read the key hidden (tested). The command with the key in it remains, as an option. |
| **The publish guard can be bypassed:** `npm publish <tarball>` does not run `prepublishOnly`. | True by npm's design. | **Partly addressed:** `release.yml` runs the guard for every package before publishing. A person publishing a tarball by hand still skips it. |
| **SQLite temporary files** (`temp_store` default) may land in the system temp folder with default permissions during large sorts. | Not verified. | **Resolved.** `temp_store = MEMORY` is set on every connection (`hardening.test.ts`, "SQLite temporary data"; mutation-tested). |
| **User-Agent text** decoded as latin1 can hold C1 controls; it is shown only in a tooltip. | Low impact; not tested. | **Resolved** (final round). The session list shows it through `sanitizeDisplayText`: C1 controls, DEL and the soft hyphen as visible escapes, backslashes doubled, 200 characters (`apps/studio/test/header-text.test.ts`; mutation-tested). It was the only header-derived text shown. |
| **`..` as a server id** in the hash route became `/api/servers/..`; no matching endpoint was found. | Inert at the time. | **Fixed later:** only UUID characters make a server link (tested). |

## Hardening round: not tested or not solved

| Item | Why | Status and next step |
| --- | --- | --- |
| **The permission model does not cover the network in Node 22 and 24** (`--allow-net` comes in Node 25). The select process closes TCP and UDP in its own script instead. | Measured on 22.17, 22.23 and 24.21: connections were attempted under `--permission`. | **Accepted with a mitigation** (tested on Windows and Linux). A way around it would need code execution inside the process, which JMESPath does not give. Next step: add `--allow-net`-style restriction when the minimum Node version allows it. |
| **Node 22.0 to 22.12** use `--experimental-permission`, picked automatically; without either flag the process runs with only its empty environment and network block. | **Not tested:** those versions were not run. | **Partly addressed.** Everything that runs Kervan's code as a program needs `^22.23.3 \|\| >=24.21.0` (the root `engines`; the oldest releases the whole suite passed on; 24.x before 24.21 crashes on Windows): Studio, and `kervan create`, `dev` and `run`, refuse anything else with one line, and a generated project's `npm start` does too. A repository test keeps every `engines`, check and document on that range (`scripts/test/node-versions.test.ts`). **Still open** for the libraries used directly (`@kervan/core`, `transport`, `spec-runtime` keep `engines >=22`, since their users choose their Node.js): the select sandbox was never run on 22.0 to 22.12. Next step: one run on 22.12, or raise their minimum before 0.1. |
| **Windows passes some system variables to every child process** (libuv: `PATH`, `SYSTEMROOT`, `USERNAME` and others), even with an empty environment. | Measured; libuv adds them. | **Accepted:** none is a Kervan secret; the test allows exactly that list. |
| **A container cannot run Studio's first setup:** before the first admin exists Studio listens on loopback only, which is the container's own. | Found while checking the Dockerfile draft. | **Resolved.** `kervan-studio create-admin` (through `docker exec`) creates the first admin; the running Studio then moves to its configured host (`apps/studio/test/create-admin.test.ts`, threat model T9; mutation-tested). |
| **The Dockerfile draft's base image is not pinned by digest.** | A draft. | **Open:** pin it before the image is used. |
| **The workflows have never run;** Dependabot's support for this pnpm version's lockfile, and trusted publishing for a first publish of new names, are not verified. | Nothing may run before the repository exists. | **Open:** check on the first CI run and the first (pre-)release (`docs/RELEASING.md`). |

## Second hardening round: independent review (review 3)

One reviewer with a fresh context reviewed the code added in the two hardening rounds: the select
process pool, session renewal, the connect-command tabs, `create-admin`, the git check and the role
change. Its tests are in `apps/studio/test/review3/` and `packages/spec-runtime/test/review/*-r3*`.

Proven and fixed (each with the reviewer's failing test, now passing, and a mutation):

- On Windows, the git check opened SMB paths a repository (or a `.git` file in a parent folder)
  named, handing NTLM credentials to the host (threat model T14).
- A select process that failed to start left its call waiting for the tool's whole timeout, with
  an error that blamed the expression (T19).
- A password given by mistake as a plain argument to `create-admin` or `reset-admin` was printed
  back in the error (T9).

Held under attack (passing tests kept, `*-confirmed-r3*`): session renewal against a concurrent
role change, deactivation, sign-out, reset and second password change; playground tokens of a
renewed session; a sign-in in flight across a promotion or demotion; the pool's limit, queue
timeouts, reply ids, cancellation and prototype keys in upstream data; every slug the server
accepts is safe in the connect commands; a `git.exe` planted in Studio's working directory is not
run.

| Suspicion | Why not proven | Status and next step |
| --- | --- | --- |
| **Admin routes that await do not check the role again:** `deleteSecret` (awaits `loadSpec`), `putSecret` and `deleteServer` complete for an admin demoted while the request was in flight. Only the account writes re-check (`requireActiveAdmin`). | A short window; the request was authorized when it was sent. | **Resolved** (final round). Every write re-checks what the API checked (`requireActor`, in BEGIN IMMEDIATE): admin actions that the actor is still an admin, every action that the user is still active. The other admin and member writes of the same kind were covered too (keys, settings, server create/delete/disable, versions, publish, profile, theme). Tested with the request held after the API's check (`apps/studio/test/authorization-recheck.test.ts`; mutation-tested). |
| **Session renewal is not one transaction with the password change:** the old session is deleted after the change commits. If that delete hit SQLITE_BUSY (another process holding the write lock past the 5 s busy timeout), the old session would survive the change. | Needs a second process holding the lock. | **Resolved** (final round). The password, the other sessions, the old session and the new one change in one transaction; the cookie is set after it commits. A failure injected into the new session's creation leaves everything as it was (`apps/studio/test/password-renewal-atomic.test.ts`; mutation-tested). |
| **The parent did not validate select replies** (a `null` message would throw in a listener; an oversized `text` passed). | Only matters with code execution in the child. | **Resolved.** Replies must be well formed, answer the running job and fit its size limit (`packages/spec-runtime/test/select-replies.test.ts`; mutation-tested). |
| **Process churn:** every timed-out or cancelled select forks a new process; cheap cancelled calls across many tools could fork often, bounded only by rate limits. | Not measured. | **Open** (still not measured at the feature freeze). Bounded by the per-tool rate limits (60 calls a minute, 10 at once by default) and by two processes at a time. Next step: measure; if needed, a short pause before forking again after kills. |
| **A FIFO in the repository could block git** (POSIX): each git call waits for its 5 s timeout. | Not tested on Linux. | **Partly addressed, still open:** a FIFO named by the config (`core.excludesFile`) no longer makes git run at all. A FIFO as an in-tree `.gitignore` remains: it delays the start by at most the timeouts of the git calls (5 s each) and does nothing else. Next step if it matters: skip the check when a `.gitignore` on the path is not a regular file. |
| **An IPv6 public URL in the connect command** (`http://[::1]:4310/...`) is not quoted, so zsh treats the brackets as a glob and the command fails. | Robustness, not injection: it fails closed. | **Resolved** (final round). The URL is a single-quoted literal in every variant (PowerShell's typographic quotes doubled too); real bash, zsh and PowerShell get every argument exactly, with IPv6 and other URLs (`apps/studio/web/test/connect-shells.test.tsx`). |

Not separately mutation-tested on Windows (the tests that cover them run only on POSIX): the
symbolic-link and ownership conditions of the git check. Each was mutation-tested in a Linux
container (Node 24.21, as an unprivileged user): removing it made its test fail.

## Website: independent review

Fixed (each with a test, a check:site rule or a verified run):

- The documented recovery from a lost master key ("set the secrets again in the UI") could not
  work: Studio does not start while a stored secret fails to decrypt. The docs now give the
  real procedure (back up, `DELETE FROM secrets`, start with the new key), run end to end.
- The CLI page said nothing about `kervan create` installing `@kervan/*` and `kervan` from npm
  before those names are registered (a failing install, or someone else's packages): a note, shown
  until `params.published` is true, points to `pnpm try:new`.
- Nothing stopped a deploy with the placeholder repository URL or npm commands: the Cloudflare
  Pages build command now ends with `check:site --strict`, and an npm command while unpublished is
  an error, not a warning.
- Claims narrowed to what the code does: spec and code tools share validation, error masking and
  timeouts (SSRF protection, redaction and rate limits are spec-tool features); mutation testing
  is described as done by hand; the export keeps the text except the `secrets` hosts; the
  self-hosting guide no longer says every step ran.
- The master key no longer goes on the command line: Node writes it to `.env.studio` (never on
  screen, never overwriting an existing file) and Studio starts with `node --env-file=.env.studio`.
- Smaller: a Studio settings text named a "Keys" tab that is labelled "API keys" (bug fix); the
  404 page had a canonical link; check:site now requires the preview `noindex` rules, a year of
  HSTS, and warns about pages without `lastmod`; the header marks a section link
  `aria-current="true"` (the page itself `"page"`); copy buttons report through a live region;
  the leak scanner finds IPv6 addresses and short user names (as whole words); the docs example
  runner works in temporary copies, cleans up on Ctrl+C, and `site:screenshots` removes its data
  folder even when Studio fails to start; `site:verify` awaited none of the response bodies it
  measured.

Accepted, with the reason:

- **`--claude` leaves an empty project entry** in Claude Code's configuration for the temporary
  folder it used (the servers themselves are removed). Using the user scope instead would touch
  the user's real configuration while the check runs.
- **`run` blocks run in the working tree** (the quickstart's `pnpm build`): that is what the block
  documents; it writes only build output.
- **CI runs check:site without `--strict`**, so the repository can be pushed while its URL is
  still the placeholder; the Pages build and release day run it strictly. The weekly
  `site-check.yml` fails until the URL is set.
- **Screenshots follow the system theme**, not the site's theme switch (`<picture>` can only test
  `prefers-color-scheme`).
- **The mutation runs of check:site's rules are in the test suite** (`site-build.test.ts`, one
  case per rule); the runs that broke the code of each rule (45 of 45 caught) and the browser
  checks (6 of 6) were done by hand, like the earlier security mutation runs.
- **macOS** is not tested for the site scripts or the docs examples (nor anywhere else).

## Still open at the feature freeze

Nothing below blocks a release candidate on its own; each needs a decision in
`docs/RELEASING.md`'s checklist ("decide for each open item whether it waits or blocks").

- **Node.js 22.0 to 22.12 for the libraries:** `@kervan/core`, `transport` and `spec-runtime`
  declare `>=22`; the select sandbox was never run there (the tools and Studio refuse those
  versions). Why open: the libraries' users choose their own Node.js, and raising the minimum is a
  release decision.
- **select process churn:** not measured. Why open: it needs a load test; it is bounded by rate
  limits and two processes.
- **A FIFO as an in-tree `.gitignore`:** delays Studio's start by the git timeouts. Why open: low
  impact (a delay, nothing else) and a rare setup.
- The earlier open items above (playground draft load churn, DNS slots per server, the Dockerfile
  base image digest, the workflows that have never run).

## Accepted risks (threat model, "Known limits")

Kept short here; the reason for each is in `docs/THREAT-MODEL-STUDIO.md`.

| Risk | From | Why it is accepted |
| --- | --- | --- |
| Gateway authentication uses per-server API keys, not OAuth 2.1 with protected resource metadata. | Phase 4a | Future work; keys are hashed, per server, revocable. |
| Single process: registries, rate limits and caches live in memory. | Phase 4a | Self-hosted single instance; several instances need a shared store. |
| A bound host's own features (for example webhooks to any URL) can still move data. | Phase 4a | Bind secrets only to hosts that cannot be used this way. |
| Regular expressions in specs' JSON Schemas may be slow (ReDoS). | Phase 3/4a | As in the framework; schema size and pattern length are limited. |
| Windows file permissions are not set by Studio. | Phase 4a (T14) | Keep the data directory in a private location. |
| Studio's own addresses are resolved once, at start. | Phase 4a | Add other fronting addresses to `KERVAN_STUDIO_DENY_NETWORK`. |
| Loopback-only setup does not help with a reverse proxy on the same machine. | Phase 4a | The single-use setup token protects a fresh install. |
| Users are deactivated, not deleted; keys a deactivated user created can stay valid. | Phase 4c | Audit records keep their actor; keys belong to servers; the admin chooses. |
| Users cannot change their own email. | Phase 4c | Emails are not verified; only an admin changes the sign-in identifier. |
| A password change ends the user's open playground streams everywhere, and the current session's playground tokens. | Phase 4c, changed in the hardening round | The playground asks for a new token when it connects again. |
| Unbounded version history. | Phase 4c | Members are trusted not to fill the disk. |
| Members can read secret bindings (names and hosts, never values) through the export. | Phase 4c | They need them to write specs. |
| An open playground stream survives sign-out until its token expires (at most 15 minutes). | Phase 4c | New requests are refused at once; deactivation ends streams. |
| Encodings the vault does not know (base64, HTML entities) are not redacted. | Phase 4c | Bind secrets to APIs trusted not to echo them. |
| One slow `select` holds one of the two select processes until its timeout. | Release review (T19) | Other calls wait within their own timeout; rate limits bound it. |
| The release review's accepted items (account lock in memory, setup behind a same-machine proxy, comments in the export, the key in the inline connect command, DNS slots, duplicate JSON keys in raw output, encoded `..%2F` in paths). | Release review | See the tables above. |
