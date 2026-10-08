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
- **Threat model**, "Known limits" (and T19's limit): the accepted risks, including those from
  earlier phases.
- **Not available:** the independent reviews at the end of phases 4a and 4c also had findings
  that were fixed (recorded in `CLAUDE.md` and the threat model), but **no record** of what else
  they suspected without proof was kept. Nothing from them is listed below.

Status: **open** (nothing done yet), **accepted** (a known limit, with the reason),
**partly addressed**, **fixed later** (proven and fixed after the report).

## Release review: suspicions not proven

### Reviewer A: authentication and authorization

| Suspicion | Why not proven | Status and next step |
| --- | --- | --- |
| **An account lock outlives `reset-admin`.** Locks live in Studio's memory; `reset-admin` runs in another process, so a locked admin stays locked after a reset. | It needs two processes and a lock in progress; no test was written. | **Accepted** (Known limits): wait out the 15 minutes or restart Studio. Next step if it bites: `reset-admin` could tell the running Studio, or locks could live in the database. |
| **The session id is not renewed when one changes one's own password, or when promoted to admin.** If the victim's own cookie was stolen, the thief stays on that session. | A design observation, not a test. | **Partly addressed:** a password change now renews the session (new cookie and CSRF token; tested, mutation-tested). Promotion still keeps the session id. Next step: renew it on role change too (the promoted user's sessions, or end them). |
| **Setup can be locked behind a reverse proxy on the same machine.** With `KERVAN_STUDIO_TRUST_PROXY=0`, every client is 127.0.0.1 to Studio, so anyone's wrong setup guesses count together (20 lock it). Contradicts "nobody can lock setup for the operator" for that deployment. | It depends on the deployment; the throttle itself works as designed. | **Accepted** (Known limits): set `KERVAN_STUDIO_TRUST_PROXY` to the number of proxies. |
| **The throttle's map can grow without bound:** a locked IP trying new account names added a counter per name. | Reported as plausible. | **Fixed later:** a refused attempt adds no counter (test "adds no counters for attempts it refuses", mutation-tested). |
| **Playground token signatures are decoded leniently:** `Buffer.from(signature, "base64url")` accepts several spellings of the same signature (malleability, not forgery). | No way to forge a token was found; only different spellings of a valid one. | **Open.** Next step: refuse a signature unless re-encoding it gives the same text (canonical base64url). Low impact: a token is already a bearer secret. |

### Reviewer B: gateway and spec runtime

| Suspicion | Why not proven | Status and next step |
| --- | --- | --- |
| **Encoded traversal in path values:** an input `../admin` is sent as `..%2Fadmin`; an upstream or proxy that decodes `%2F` before routing (some nginx rules) could treat it as traversal. Kervan refuses only `.`, `..` and empty values. | It depends on the upstream's server; encoding slashes inside a value is deliberate (tested). | **Accepted** (Known limits). Possible next step: refuse values containing `../` or `..\` in path positions. |
| **DNS lookup slots can be used up from one server:** only 2 lookups run at once in the whole process; a tool whose name server never answers keeps slots busy until its timeout, and other servers' tools wait. | Needs a DNS server that never answers; not built into the tests. | **Accepted** (Known limits). Next step if needed: lookup slots per server, or a shorter DNS deadline than the tool's timeout. |
| **Memory from member-set limits:** a member can set `concurrency: 1000` with `maxResponseBytes: 50 MB` on a tool. | Not demonstrated; the spec limits are bounded, but their product is large. | **Partly accepted** (Known limits mention member-chosen bounded limits). Next step: Studio-wide lower caps on concurrency and response size per server. |
| **Load churn from the playground:** cycling through more than 32 drafts forces a full `loadSpec` on every request (up to 600 per minute per user). | Not measured. | **Open.** Next step: measure; if it matters, a per-user limit on draft loads. |
| **Duplicate JSON keys in `raw: true` output:** if the upstream sends a key twice with an escaped secret in the copy `JSON.parse` drops, the value-by-value redaction does not see it (text redaction still runs). | Needs an upstream that cooperates with the attack. | **Accepted** (Known limits). |
| **Studio's logger formatting:** `inspect` has its own escaping and cuts strings at 10,000 characters, which could break redaction for secrets with unusual characters or very long secrets, if they ever reached logged data. | No path that logs a secret was found. | **Open.** Next step: redact before `inspect`, or test a long secret with unusual characters through the logger. |

### Reviewer C: user-supplied text, terminals and supply chain

| Suspicion | Why not proven | Status and next step |
| --- | --- | --- |
| **Windows data-directory ACL:** the default `.kervan-studio` lives in the working directory; on a non-system drive `Authenticated Users` may have modify rights, so another local user could read or change the database (and bypass its triggers). | Seen with `icacls` on the reviewer's machine; it depends on the drive's ACL. | **Accepted** (Known limits, T14: Studio does not set Windows permissions). Next step: warn at start when the folder's ACL is broad. |
| **`kervan studio` forwarding** walks up to the file system root and imports any ancestor `package.json` named `@kervan/studio`, with no containment check on its `./cli` path. | Comparable to Node's own module resolution; matters only on shared machines. | **Open.** Next step: stop at the project root (the nearest `package.json`), or check the path stays inside the package. |
| **The exported `kervan.yaml` keeps a member's comments**, including a `yaml-language-server: $schema=https://...` line an editor would follow (and show its hovers). | Editor behavior, outside Kervan. | **Accepted** (Known limits): the export is the saved text, byte for byte. |
| **The `git` start-up check runs `git` in the data directory:** inside an untrusted worktree (an extracted archive with its own `.git/config` and `core.fsmonitor`), git could run commands. | Needs an attacker-prepared directory; git's `safe.directory` check already refuses repositories owned by another user. | **Open.** Next step: run git with `-c core.fsmonitor=false` (and no hooks), or skip the check when the repository is not owned by the current user. |
| **The connect command puts the key in shell history.** | A usage observation. | **Partly addressed:** Studio also offers bash/zsh and PowerShell commands that read the key hidden (tested). The command with the key in it remains, as an option. |
| **The publish guard can be bypassed:** `npm publish <tarball>` does not run `prepublishOnly`. | True by npm's design. | **Partly addressed:** `release.yml` runs the guard for every package before publishing. A person publishing a tarball by hand still skips it. |
| **SQLite temporary files** (`temp_store` default) may land in the system temp folder with default permissions during large sorts. | Not verified. | **Open.** Next step: `PRAGMA temp_store = MEMORY`, or check where SQLite writes them. |
| **User-Agent text** decoded as latin1 can hold C1 controls; it is shown only in a tooltip. | Low impact; not tested. | **Open.** Next step: pass it through the same visible-escape rule as other untrusted text. |
| **`..` as a server id** in the hash route became `/api/servers/..`; no matching endpoint was found. | Inert at the time. | **Fixed later:** only UUID characters make a server link (tested). |

## Hardening round: not tested or not solved

| Item | Why | Status and next step |
| --- | --- | --- |
| **The permission model does not cover the network in Node 22 and 24** (`--allow-net` comes in Node 25). The select process closes TCP and UDP in its own script instead. | Measured on 22.17, 22.23 and 24.21: connections were attempted under `--permission`. | **Accepted with a mitigation** (tested on Windows and Linux). A way around it would need code execution inside the process, which JMESPath does not give. Next step: add `--allow-net`-style restriction when the minimum Node version allows it. |
| **Node 22.0 to 22.12** use `--experimental-permission`, picked automatically; without either flag the process runs with only its empty environment and network block. | **Not tested:** those versions were not run. | **Open.** Next step: one run on 22.12, or raise the libraries' minimum to 22.13. |
| **Windows passes some system variables to every child process** (libuv: `PATH`, `SYSTEMROOT`, `USERNAME` and others), even with an empty environment. | Measured; libuv adds them. | **Accepted:** none is a Kervan secret; the test allows exactly that list. |
| **A container cannot run Studio's first setup:** before the first admin exists Studio listens on loopback only, which is the container's own. | Found while checking the Dockerfile draft. | **Open** (an open decision in `docs/RELEASING.md`). Recommended: a `kervan-studio create-admin` command. |
| **The Dockerfile draft's base image is not pinned by digest.** | A draft. | **Open:** pin it before the image is used. |
| **The workflows have never run;** Dependabot's support for this pnpm version's lockfile, and trusted publishing for a first publish of new names, are not verified. | Nothing may run before the repository exists. | **Open:** check on the first CI run and the first (pre-)release (`docs/RELEASING.md`). |

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
