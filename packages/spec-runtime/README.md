# @kervan/spec-runtime

Turns a declarative `kervan.yaml` file into MCP tools that call HTTP APIs. Every spec tool compiles
to an ordinary `app.tool()` definition, so anything a spec does can also be done in code
(`httpTool()`).

> **Status:** pre-release. Network-level SSRF protection (blocking private and internal addresses,
> DNS pinning, redirect re-validation) is the next step and **not in this version yet**. Until it
> lands, only run specs you wrote or trust.

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
| `defaults.http` | `timeoutMs`, `maxResponseBytes`, `maxOutputChars`, `allowInsecureHttp` for every tool |
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
| URL | Scheme, host and port must be literal. Templates only in the path, each value percent-encoded; `.`/`..` are rejected. |
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
| Redirects | Not followed |
| Upstream errors | Reported as `Upstream returned 404 Not Found.` (no URL, query, body or upstream text) |
| Spec file | 1 MiB, 200 tools, 50 YAML aliases |

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

## Limits of this version

- Node.js only: the executor uses `node:http` (fetch runtimes cannot control DNS).
- No network-level SSRF protection yet (see the status note above).
