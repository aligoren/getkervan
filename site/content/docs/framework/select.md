---
title: select and its limits
seoTitle: 'JMESPath select in kervan.yaml: limits'
description: 'Use JMESPath select expressions in kervan.yaml to pick and reshape API responses, with examples, limits and the sandboxed process they run in.'
lead: '`select` is a JMESPath expression over the JSON response. It decides exactly which fields reach the model.'
weight: 35
group: Build with YAML
fits: 'Build with YAML. The last step of a spec tool''s call: it picks what the model sees from the [response](/docs/framework/input-output/).'
next:
  - url: /docs/framework/secrets/
    text: 'Secrets'
  - url: /docs/framework/security/
    text: 'Security model'
    note: 'why select runs in a separate process'
---

## Examples

Given a response like `{"results": [{"name": "Ankara", "country": "Türkiye", "latitude": 39.9, ...}]}`:

| Expression | Result |
| --- | --- |
| `results[0].name` | `"Ankara"` |
| `results[].name` | `["Ankara", ...]` |
| `results[].{name: name, lat: latitude}` | `[{"name": "Ankara", "lat": 39.9}, ...]` |
| `results[?country == 'Türkiye'].name` | names of the matching entries |
| `length(results)` | the number of entries |

The full language is at [jmespath.org](https://jmespath.org). Kervan evaluates it with
`@jmespath-community/jmespath`, an interpreter with no code execution, and registers no custom
functions.

## Limits

- An expression is at most 1,000 characters.
- The response must be JSON (`raw: true` is for text).
- The result is cut at `maxOutputChars`.

A short expression can still be expensive: JMESPath functions build strings and arrays, and `map`
nests. So expressions do not run in your server's process:

- They run in a separate process (two at most), with its own memory limit, stopped when the
  tool's timeout runs out. A runaway expression fails its own call; your server keeps serving.
- That process gets an empty environment and only the data, already redacted, and the
  expression.
- Under Node's permission model it can read only the files it loads, and cannot write files,
  start processes or workers. Node 22 and 24 leave the network out of the permission model, so
  the process closes TCP and UDP itself.
- If the process cannot start (for example when the system is out of processes), the call fails
  at once with "output.select could not run".

## Errors

An expression that does not parse is a load error with its line and column. One that fails on a
particular response (a function given the wrong type) fails that call with
`output.select failed: ...`; the message names the problem, never the data.
