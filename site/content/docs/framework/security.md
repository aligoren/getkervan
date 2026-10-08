---
title: Security model
seoTitle: 'Kervan security model and SSRF protection'
description: 'What the Kervan MCP framework protects against: SSRF protection for spec tools, Host and Origin checks, limits, error masking and secret redaction.'
lead: The defaults are on. This page lists what they protect against, how, and where the protection ends.
weight: 120
---

## Defaults for every server

- **Timeouts:** 30 seconds per tool call by default (`limits.toolTimeoutMs`); cancellation and
  timeouts reach the handler as `ctx.signal`.
- **Size limits:** request bodies (4 MiB over HTTP), argument size (10,000 array elements and
  object members), and for spec tools response sizes, output length and spec size.
- **Error masking:** only `ToolError` messages reach the client. Anything else becomes
  `Internal error in tool "x" (ref: ...)`, with the real error in your logs under that ref.
- **HTTP:** binds to `127.0.0.1` by default; `Host` and `Origin` are checked against
  `allowedHosts` and `allowedOrigins` (DNS rebinding protection); a per-client rate limit
  (300 requests a minute) on Node; logs go to stderr, never stdout.
- **Validation:** arguments are checked against the input schema before a handler runs, and
  structured results against the output schema.

## Network (SSRF) protection

Spec tools make HTTP requests to URLs a spec author writes and a model fills in. These checks keep
them on the public internet:

{{% include file="packages/spec-runtime/README.md" section="Network (SSRF) protection" %}}

## Secrets and untrusted output

- Secret values are redacted from results, errors and logs, in their raw, URL-encoded,
  form-encoded and JSON-escaped forms, and from the response before `select` runs. Encodings
  Kervan does not know (base64, HTML entities) are not redacted: bind secrets only to APIs you
  trust not to echo them. See [secrets](/docs/framework/secrets/).
- An API response is untrusted input for the model. `select` limits it to chosen fields, but
  text inside a chosen field can still carry instructions (prompt injection); Kervan cannot judge
  content.

## How the checks are tested

Each address check, redaction form and limit has tests that show it working. They were also
mutation-tested: each check was broken on purpose, one at a time, and the run counted only when a
test failed. That was done by hand during development, not on every change; the open questions the
security reviews left are listed in the repository's `docs/REVIEW-NOTES.md`.

## Known limits

{{% include file="packages/spec-runtime/README.md" section="Known limits" %}}

## Reporting a vulnerability

Report it privately, through the repository's private vulnerability reporting or to
[security@getkervan.dev](mailto:security@getkervan.dev), never in a public issue. Reports are
acknowledged within 5 working days, and disclosure is coordinated (90 days). The
[security.txt](/.well-known/security.txt) of this site has the contact too.
