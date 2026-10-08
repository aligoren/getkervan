---
title: Input and output
seoTitle: 'Map MCP tool arguments and API responses'
description: How a spec tool's input schema becomes the arguments a model sends, and how select, output schemas and raw output turn an API response into the tool result.
lead: The input schema is what the model must send; the output section is what it gets back. Both are deliberate in Kervan.
weight: 30
group: Build with YAML
fits: 'Build with YAML. Between the [HTTP request](/docs/framework/http-tools/) and the [select expression](/docs/framework/select/).'
next:
  - url: /docs/framework/select/
    text: 'select'
  - url: /docs/framework/secrets/
    text: 'Secrets'
---

## Input: the arguments

`input` is a JSON Schema of type `object`. Clients list it as the tool's `inputSchema`, and every
call is validated against it before any request is made: invalid arguments come back to the model
as a tool error it can read and fix, and no request is sent.

```yaml {check="fragment"}
input:
  type: object
  properties:
    latitude: { type: number, minimum: -90, maximum: 90 }
    longitude: { type: number, minimum: -180, maximum: 180 }
    units: { type: string, enum: [metric, imperial] }
  required: [latitude, longitude]
```

Arguments reach the request only through templates (`{{input.latitude}}`), each encoded for its
place; see [HTTP tools](/docs/framework/http-tools/#templates).

## Output: what the model sees

An API response is untrusted input for the model: it can be large, and it can carry instructions
(prompt injection). A spec tool therefore has to choose:

- `select`: a [JMESPath](/docs/framework/select/) expression that picks and reshapes the fields
  the model needs (required unless `raw` is set);
- `raw: true`: the response body as text, for the cases where the whole body is the point.

```yaml {check="fragment"}
output:
  select: "{temperatureC: current.temperature_2m, windKmh: current.wind_speed_10m}"
  schema:
    type: object
    properties:
      temperatureC: { type: number }
      windKmh: { type: number }
    required: [temperatureC, windKmh]
```

- With `schema`, the selected value becomes the result's `structuredContent` (validated against
  the schema) as well as text. Clients see the schema as the tool's `outputSchema`.
- Output is cut at `maxOutputChars` (20,000 characters by default).
- Secret values are redacted from the response **before** `select` runs, so an expression cannot
  reshape or probe a secret an API echoed.

The [quickstart's example](/docs/framework/quickstart/) shows a real result:

{{< example part="call" >}}

## Schemas in a spec

{{% include file="packages/spec-runtime/README.md" section="Schemas written in a spec" %}}
