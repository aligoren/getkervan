---
title: Troubleshooting
seoTitle: Troubleshooting Kervan MCP servers, common errors
description: 'Common Kervan errors and their fixes: Node.js versions, spec load errors, refused addresses, Host checks, secrets, timeouts and missing tools.'
lead: The messages you are most likely to meet, what they mean, and the fix.
weight: 95
group: Run and operate
fits: 'Run and operate. Messages you may see, and what to do.'
next:
  - url: /docs/framework/versioning/
    text: 'Versioning and upgrades'
  - url: /docs/framework/cli/
    text: 'CLI reference'
---

## "Kervan needs Node.js ..."

Kervan's commands refuse Node.js versions outside 22.23.3 or a later 22.x, or 24.21.0 or later.
Check with `node --version` and upgrade. On Windows, Node.js 24 before 24.21 also crashes now and
then with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`.

## A spec does not load

`kervan run` prints every problem with its file, line and column, for example
`kervan.yaml:12:5 tools[0].http.url: The URL's host and port cannot be templated.` Common causes:

- an unknown field (often a typo such as `timeoutMS`): the [reference](/docs/framework/spec-reference/)
  lists every field;
- a template in the URL's host or port, or anything other than `{{input.x}}` and
  `{{secrets.NAME}}` inside braces;
- `host: 443` in a secret's `hosts` list: YAML reads `host: port` with a space as a key and a value.
  Write `host:443`;
- hidden characters (control, bidi, zero-width) in names, titles or descriptions.

## "... resolves to a disallowed address"

The [SSRF protection](/docs/framework/security/#network-ssrf-protection) refused the request: the
host resolves to a private, loopback or cloud metadata address, or to this machine. For a local
API during development only, `kervan run --allow-private-network` allows private addresses (it is
refused with `NODE_ENV=production`); cloud metadata addresses stay refused.

## 403 from an HTTP server

The `Host` header is not in `allowedHosts` (or an `Origin` header is not allowed). Off localhost,
start with `--allowed-host <the name clients use>`, and keep the original `Host` header in your
proxy.

## "Secret X is not configured for host:port"

The value is missing (no environment variable, no line in the `--env-file`), or the secret is bound
to other hosts. The message is the same for both on purpose.

## "output.select took longer than ... ms"

The expression ran past the tool's timeout and was stopped. Simplify it, or raise `timeoutMs`.
"needed more memory than it may use" means it hit the select process's memory limit.

## A client does not see new tools

2026-07-28 clients get `list_changed` when they listen; 2025-era clients over HTTP are served
statelessly and see changes only on their next `tools/list`. See the
[protocol notes](/docs/framework/protocol/#list_changed).

## "Internal error in tool ... (ref: ...)"

The handler threw something other than a `ToolError`. The client sees only the reference; find it in
the server's log (stderr) for the real error.
