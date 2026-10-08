---
title: HTTP tools
seoTitle: 'HTTP tools in kervan.yaml: URL, query, body'
description: How a kervan.yaml tool turns its arguments into an HTTP request; methods, URL paths, query strings, headers, JSON bodies, timeouts, redirects and limits.
lead: Each spec tool makes one HTTP request. This page covers how the request is built and what limits apply to it.
weight: 25
group: Build with YAML
fits: 'Build with YAML. How a spec entry becomes an HTTP request; the [reference](/docs/framework/spec-reference/) lists every field.'
next:
  - url: /docs/framework/input-output/
    text: 'Input and output'
    note: 'arguments in, results out'
  - url: /docs/framework/secrets/
    text: 'Secrets'
---

## The request

```yaml {check="spec"}
specVersion: 1
name: tickets
version: 1.0.0
tools:
  - name: create_ticket
    description: Opens a support ticket and returns its id.
    input:
      type: object
      properties:
        project: { type: string, pattern: "^[a-z0-9-]{1,40}$" }
        title: { type: string, maxLength: 200 }
        urgent: { type: boolean }
      required: [project, title]
    http:
      method: POST
      url: https://api.example.com/v1/projects/{{input.project}}/tickets
      headers: { Accept: application/json }
      body:
        title: "{{input.title}}"
        priority: "{{input.urgent}}"
        source: mcp
    output:
      select: "{id: id, url: html_url}"
```

| Field | Description |
| --- | --- |
| `method` | `GET` (default), `POST`, `PUT`, `PATCH` or `DELETE`. |
| `url` | The scheme, host and port are literal; templates only in the path. |
| `query` | Query parameters; an array value repeats the parameter, an omitted optional argument leaves it out. |
| `headers` | Literal names; values may hold templates. |
| `body` | A JSON value. Strings may hold templates. |
| `timeoutMs`, `maxResponseBytes`, `followRedirects`, `allowInsecureHttp` | Per-tool limits; `defaults.http` sets them for every tool. |

## Templates

Values are encoded for where they go, so an argument can never change the shape of the request:

{{% include file="packages/spec-runtime/README.md" section="Templates" %}}

In the example above, `"{{input.urgent}}"` is exactly one reference, so `priority` stays a JSON
boolean in the body.

## Limits

{{% include file="packages/spec-runtime/README.md" section="Built-in limits" %}}

Change them per tool or for every tool:

```yaml {check="fragment"}
defaults:
  http: { timeoutMs: 8000, maxResponseBytes: 262144, followRedirects: 2 }
  rateLimit: { perMinute: 30, concurrency: 5 }
```

Rate limits count calls per tool, per process.

## Redirects

Redirects are not followed unless `followRedirects` allows it (at most 5). Every hop is resolved
and checked again like the first request; `https` to `http` downgrades are refused, and when the
origin changes, every header from the spec is dropped except `Accept` and `User-Agent`, and the
body is not sent. The [security model](/docs/framework/security/#network-ssrf-protection) has the
details.

## Plain http

`https` is required by default. `allowInsecureHttp: true` allows `http://` URLs for a tool (or all
tools), but a tool that sends a secret must still use `https`; see
[secrets](/docs/framework/secrets/).
