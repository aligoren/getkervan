---
title: YAML or TypeScript?
seoTitle: YAML spec or TypeScript tools in Kervan
description: When to describe an MCP tool in kervan.yaml and when to write it in TypeScript with Kervan; the same tool both ways, what each gives you, and how to mix them.
lead: A spec when a tool is one HTTP request; TypeScript when it needs logic. Both end up as the same kind of tool.
weight: 18
group: Concepts
fits: 'Concepts. After [how Kervan works](/docs/framework/how-kervan-works/); it leads into the YAML and TypeScript groups of this book.'
next:
  - url: /docs/framework/spec-reference/
    text: The kervan.yaml reference
    note: every field of a spec
  - url: /docs/framework/code/
    text: Tools in TypeScript
    note: the code API
  - url: /docs/framework/code/#a-spec-tool-in-code
    text: A spec tool in code
    note: both in one server
---

## The same tool, both ways

The job: find a city by name and return the first match's name, country and coordinates, from
the public [Open-Meteo](https://open-meteo.com) geocoding API.

### As a spec

Save it as `geo.yaml` and serve it with `kervan run geo.yaml`, or try it with `kervan dev geo.yaml`:

```yaml {check="spec" id="geo"}
specVersion: 1
name: geo
version: 0.1.0
tools:
  - name: find_city
    title: Find city
    description: The first place with this name, and its coordinates.
    annotations: { readOnlyHint: true }
    input:
      type: object
      properties:
        name: { type: string, minLength: 2, maxLength: 100, description: "City name, e.g. Ankara" }
      required: [name]
    http:
      url: https://geocoding-api.open-meteo.com/v1/search
      query: { name: "{{input.name}}", count: 1, language: en, format: json }
    output:
      select: "results[0].{name: name, country: country, latitude: latitude, longitude: longitude}"
      schema:
        type: object
        properties:
          name: { type: string }
          country: { type: string }
          latitude: { type: number }
          longitude: { type: number }
        required: [name, country, latitude, longitude]
```

In the `kervan dev geo.yaml` inspector:

```text {check="repl" spec="geo" network="true"}
kervan> call find_city {"name": "Ankara"}
structured: {"name":"Ankara","country":"Republic of Türkiye","latitude":39.91987,"longitude":32.85427}
```

### In TypeScript

The same tool in code, called in memory the way a client would. Run it with `node geo.ts` in a
project made by `pnpm try:new` (or, once published, `npm create kervan`):

```ts {check="ts-run" expect="first: Ankara, Republic of Türkiye" network="true"}
import { createApp, ToolError, z } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"

const app = createApp({ name: "geo", version: "0.1.0" })

const Place = z.object({
  name: z.string(),
  country: z.string(),
  latitude: z.number(),
  longitude: z.number(),
})

app.tool("find_city", {
  title: "Find city",
  description: "The first place with this name, and its coordinates.",
  input: z.object({ name: z.string().min(2).max(100).describe("City name, e.g. Ankara") }),
  output: Place,
  annotations: { readOnlyHint: true },
  handler: async ({ name }, ctx) => {
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search")
    url.search = new URLSearchParams({ name, count: "1", language: "en", format: "json" }).toString()
    const response = await fetch(url, { signal: ctx.signal })
    if (!response.ok) throw new ToolError(`The geocoding API answered ${response.status}.`)
    const body = (await response.json()) as { results?: z.infer<typeof Place>[] }
    const first = body.results?.[0]
    if (!first) throw new ToolError(`No place is called "${name}".`)
    // Only the fields the model needs; never the whole API response.
    return { name: first.name, country: first.country, latitude: first.latitude, longitude: first.longitude }
  },
})

const client = await createTestClient(app)
const result = await client.callTool({ name: "find_city", arguments: { name: "Ankara" } })
const place = result.structuredContent as z.infer<typeof Place>
console.log(`first: ${place.name}, ${place.country}`)
await client.close()
```

## Which one

| Aspect | A spec (`kervan.yaml`) | TypeScript |
| --- | --- | --- |
| A tool is | one HTTP request: URL, query, headers, body from templates | any code |
| Output | chosen with a JMESPath `select` | whatever the handler returns |
| SSRF protection, secret redaction, a rate limit per tool | built in | yours to add (or [load a spec](/docs/framework/code/#a-spec-tool-in-code) for those tools) |
| Secrets | named in the spec, read from the environment, bound to hosts | your code reads them |
| Several calls, retries, branching, other protocols | no | yes |
| Changes | edit the file; `kervan run --watch` reloads it | edit the code; `kervan dev` restarts it |
| Tests | `kervan dev` inspector, or `createTestClient` with the loaded spec | `createTestClient` |

Choose a spec when each tool maps to one request of an HTTP API and the response needs only
picking, not computing. Choose TypeScript when a tool calls more than one thing, decides
something, keeps state, or talks to something other than HTTP. Both are validated, timed and
error-masked the same way ([how Kervan works](/docs/framework/how-kervan-works/#what-every-tool-gets-and-what-spec-tools-add)).

## Limits of a spec

- One request per tool, to an `https` URL whose scheme, host and port are fixed in the spec.
- Templates substitute values (`{{input.x}}`, `{{secrets.X}}`); there are no conditions or loops.
- Redirects are not followed unless allowed, and then each step is checked again.
- No state between calls.

Anything past these is a TypeScript tool, and the two kinds can live in one server.
