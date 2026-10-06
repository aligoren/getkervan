# Security policy

## Supported versions

Kervan is in its 0.x series. Security fixes go into the latest 0.x release only.

| Version | Supported |
| --- | --- |
| 0.1.x (latest) | Yes |
| Older | No |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**.
<!-- MAINTAINER: until the repository is public, add a private contact address here. -->

Please include:

- the affected package(s) and version(s), and your Node.js version and OS;
- what an attacker can do, and under which assumptions (who controls the spec, the client, the
  upstream API, the network);
- a minimal reproduction: a spec, a tool definition or a test is ideal;
- whether you plan to disclose it, and when.

What to expect: we aim to acknowledge a report within 3 working days, to confirm or rule out the
issue within 10 working days, and to release a fix for confirmed issues as soon as it is ready,
with a security advisory that credits you unless you ask us not to. We will keep you informed
along the way. Please give us a reasonable time to fix the issue before disclosing it.

## Security model

Kervan runs tools that a model asks for, sometimes on behalf of people other than the operator.
It treats these as untrusted: tool arguments, MCP clients, data returned by upstream APIs, and
(for specs) the network those APIs live on. Spec files are written by semi-trusted authors (for
example users of a hosted editor): a spec must not be able to reach places the operator did not
allow, or read secrets it did not declare.

What the defaults guarantee:

- **Error masking.** Only `ToolError` messages reach the client; other errors are logged with a
  reference id.
- **Local HTTP servers.** They bind to `127.0.0.1` and validate `Host` and `Origin` (DNS
  rebinding). `kervan dev` always does.
- **Multi-tenancy.** Each tenant's tool set has its own notification channel. Tenant resolution
  happens after authentication, and errors never name a tenant.
- **Spec network access (SSRF).** Only public unicast addresses are reachable. Encoded IP forms,
  IPv4-mapped and other embedded addresses, link-local ranges, and this machine's own interface
  addresses are refused. Cloud metadata endpoints (including Azure's public WireServer address)
  are refused even when private networks are allowed for development. DNS is resolved once and the connection is pinned
  to the checked addresses. Redirects are not followed unless allowed, and are then checked hop by
  hop, with every spec header except `Accept`/`User-Agent` dropped across origins. Every check
  fails closed. The checks are covered by tests, and the tests were verified by deliberately
  breaking each check.
- **Spec templates.** Only `{{input.x}}` and `{{secrets.X}}`, with no logic. Values are escaped
  for their context (URL path, query, header, JSON body). Header injection and path traversal are
  rejected.
- **Secrets.** Only declared names resolve, and short values are rejected.
  - Raw and encoded forms are removed from results, errors and logs, and from upstream data
    before a spec's `select` sees it.
  - A secret can be bound to `host:port` pairs (port 443 by default), checked at load, before
    every request and on every redirect hop.
  - Secrets are never sent over plain http.
- **Limits.** Timeouts, response sizes (also after decompression), content types, JSON Schema
  complexity (no remote `$ref`), and per-tool rate limits.

### Out of scope

These are known and documented, so not vulnerabilities:

- Behavior you opt into: `--allow-private-network` / `network.allowPrivate`,
  `--allow-insecure-secrets` / `allowSecretsOverHttp`, `allowInsecureHttp`,
  `followRedirects`, `raw: true` output, binding to a public interface.
- Code you write in tool handlers or middleware: Kervan cannot sandbox it.
- Prompt injection carried inside a field that a spec explicitly selects. Kervan narrows what
  reaches the model, but cannot judge content.
- Limits listed in the packages' "Known limits" sections:
  - no `HTTPS_PROXY` support;
  - spec tools are Node-only;
  - slow regular expressions written in a spec's own schemas (ReDoS);
  - DNS lookups cannot be cancelled (they are capped instead);
  - forced process kills on macOS are untested;
  - the Node 24.15 libuv crash on Windows.

## Hardening checklist for operators

- Run `kervan run` / `serveHttp` on `127.0.0.1` behind a reverse proxy. If you bind elsewhere, set
  `--allowed-host` / `allowedHosts`.
- Authenticate HTTP clients (`authenticate`) and derive tenants from the verified credential.
- Use `--deny-network` / `network.denyList` for internal ranges that are publicly routable in your
  environment.
- Keep secrets in the environment or an env file outside version control (`.env` is git-ignored
  in generated projects), and give each spec only the secrets it needs.
- Keep Node.js and Kervan up to date.
