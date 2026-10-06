# @kervan/spec-runtime

Turns a declarative `kervan.yaml` file into MCP tools that call HTTP APIs. Every spec tool compiles
to an ordinary `app.tool()` definition, so anything a spec does can also be done in code
(`httpTool()`).

> **Status:** pre-release. Run specs with `kervan run kervan.yaml` or `kervan dev kervan.yaml`.

```yaml
# yaml-language-server: $schema=./node_modules/@kervan/spec-runtime/schema/kervan.schema.json
specVersion: 1
name: weather
version: 0.1.0
secrets: [OPENWEATHER_KEY]
tools:
  - name: get_current_weather
    description: Current temperature and wind for a coordinate.
    annotations: { readOnlyHint: true }
    input:
      type: object
      properties: { lat: { type: number }, lon: { type: number } }
      required: [lat, lon]
    http:
      url: https://api.openweathermap.org/data/2.5/weather
      query: { lat: "{{input.lat}}", lon: "{{input.lon}}", appid: "{{secrets.OPENWEATHER_KEY}}" }
    output:
      select: "{temperature: main.temp, wind: wind.speed}"
```

```ts
import { createApp } from "@kervan/core"
import { applySpec, loadSpec } from "@kervan/spec-runtime"

const app = createApp({ name: "weather", version: "0.1.0" })
applySpec(app.registry, await loadSpec(await readFile("kervan.yaml", "utf8")))
```

## Format

| Field | |
| --- | --- |
| `specVersion` | Always `1` |
| `name`, `version`, `description` | Server identity |
| `secrets` | Names usable as `{{secrets.NAME}}`. Only declared names are resolved. |
| `defaults.http` | `timeoutMs`, `maxResponseBytes`, `maxOutputChars`, `allowInsecureHttp`, `followRedirects` for every tool |
| `defaults.rateLimit`, `tools[].rateLimit` | `perMinute` (default 60) and `concurrency` (default 10) per tool |
| `tools[].name`, `description`, `title`, `annotations` | As in the code API. `openWorldHint` defaults to `true`. |
| `tools[].input` | JSON Schema of the arguments (`type: object`) |
| `tools[].http` | `method` (default `GET`), `url`, `query`, `headers`, `body` (JSON), and per-tool limits |
| `tools[].output` | `select` (JMESPath, required) with optional `schema`, or `raw: true` |

Errors name the file, line and column: `kervan.yaml:12:5 tools[0].http.url: The URL's host and
port cannot be templated.`

## Templates

Only `{{input.field.sub}}` and `{{secrets.NAME}}`. No logic, filters or expressions; anything else
is a load error. `\{{` writes a literal `{{`. Values are encoded for where they go:

| Where | How |
| --- | --- |
| URL | Scheme, host and port must be literal. Templates only in the path, each value percent-encoded; empty values, `.`/`..`, and values that form a dot segment with the literal text around them are rejected. |
| `query` | Set through `URLSearchParams`; an array value repeats the parameter; a missing optional value leaves it out |
| `headers` | Names are literal; values with CR, LF, NUL or other control characters are rejected |
| `body` | Built as a JSON value, never by string concatenation. A string that is exactly one reference keeps the value's type. |

## Output

External API responses are untrusted input for the model (prompt injection). A tool must either
`select` the fields it needs with a [JMESPath](https://jmespath.org) expression (at most 1,000
characters), which can also reshape them (`items[].{id: id, name: name}`), or opt into
`raw: true`. Output is cut at `maxOutputChars` (20,000 by default). With `output.schema`, the
selected value becomes `structuredContent` and is validated.

JMESPath is evaluated by `@jmespath-community/jmespath` (MPL-2.0), an interpreter with no code
execution; Kervan registers no custom functions.

## Built-in limits

| | Default |
| --- | --- |
| Scheme | `https` only; `allowInsecureHttp: true` allows `http` |
| Timeout | 10 s |
| Response size | 1 MiB, counted while streaming and again after decompression (gzip, deflate, br) |
| Content type | JSON for `select`; text or JSON for `raw` |
| Redirects | Not followed (`followRedirects: 1..5` to allow; every hop is checked again) |
| Rate limit | 60 calls per minute and 10 at once, per tool |
| Network | Public unicast addresses only (see below) |
| Upstream errors | Reported as `Upstream returned 404 Not Found.` (no URL, query, body or upstream text) |
| Spec file | 1 MiB, 200 tools, 50 YAML aliases |

## Network (SSRF) protection

Every request, and every redirect hop, goes through the same checks, and each fails closed:

1. The URL is parsed with the WHATWG parser, which turns encodings such as `2130706433`,
   `0x7f.1` or `0177.0.0.1` into `127.0.0.1`; the scheme, host and port are literal in the spec.
2. The host name is resolved **once**, within the request timeout. Empty answers, resolver errors
   and anything that is not a strictly valid IP address (including IPv6 zone IDs such as
   `%eth0`) block the request.
3. **Every** address must be public unicast: the address classifier (`ipaddr.js`) must say
   `unicast` **and** the address must be outside an independent list of internal ranges
   (loopback, private, link-local and cloud metadata such as `169.254.169.254`, CGNAT, unique
   local, multicast, documentation, benchmarking, NAT64, 6to4, Teredo, every IPv4-mapped IPv6
   address, and all IPv6 space outside the global unicast block `2000::/3`). One internal address
   among public ones blocks the whole request.
4. The connection is pinned to the checked addresses through a custom `lookup` (no second DNS
   query, so no DNS rebinding window), on a fresh connection, and the socket's remote address is
   checked again when it connects.
5. Redirects are not followed unless `followRedirects` allows it. Each hop is resolved and checked
   again; `https` to `http` downgrades, credentials in the location and other schemes are refused;
   when the origin changes, headers carrying secrets plus `Authorization`, `Cookie` and
   `Proxy-Authorization` are dropped, and a request body is never sent to another origin.

For local development, `kervan run --allow-private-network` (refused with `NODE_ENV=production`)
or the `network.allowPrivate` option in code allows internal addresses. A spec file cannot turn
this on.

## Schemas written in a spec

`input` and `output.schema` are JSON Schema 2020-12. Only same-document `$ref`s (`#/...`) are
allowed, so nothing is ever fetched; `$id` and dynamic references are refused. Schemas are limited
to 32 levels, 2,000 nodes, 64 `anyOf`/`oneOf`/`allOf` keywords, 64 KiB and 512-character patterns.

## Secrets

`{{secrets.NAME}}` values come from a `SecretSource` (environment variables by default). They are
never put in error messages or logs, and every result and error a spec tool returns is scrubbed of
them, including their URL-encoded, form-encoded and JSON-escaped forms, in case the API echoes them
back. Secrets shorter than 8 characters are rejected, because short values cannot be redacted
reliably.

## Editor support

Add the comment line above to the top of `kervan.yaml`, or map the schema in VS Code settings
(with the Red Hat YAML extension):

```json
{ "yaml.schemas": { "./node_modules/@kervan/spec-runtime/schema/kervan.schema.json": "kervan.yaml" } }
```

## Known limits

- **Node.js only**: the executor uses `node:http` and `node:dns`. Fetch runtimes (Workers, Deno)
  cannot pin DNS, so specs are not supported there.
- **No proxy support**: `HTTPS_PROXY`/`HTTP_PROXY` are ignored. Behind a mandatory outbound proxy,
  spec tools cannot reach the internet.
- **Regular expressions** in schemas (`pattern`) run on the JavaScript engine; the length limit
  reduces, but does not remove, the risk of slow patterns (ReDoS) from spec authors.
- Rate limits are per process.
