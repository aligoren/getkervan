---
title: kervan.yaml reference
seoTitle: 'kervan.yaml reference: every field'
description: Every field of a kervan.yaml spec with its type, default and limits, generated from the editor JSON Schema, plus how templates and errors work.
lead: A `kervan.yaml` file declares an MCP server whose tools are HTTP requests. This page lists every field, generated from the spec's JSON Schema.
weight: 20
---

## A complete example

{{< example part="spec" >}}

Two things to know before the table:

- `specVersion` is always `1`. A breaking change of the format would become `specVersion: 2`.
- Unknown fields are errors, and every error names the file, line and column, for example
  `kervan.yaml:12:5 tools[0].http.url: The URL's host and port cannot be templated.`

## Fields

`tools[].output` has two forms: `select` (with an optional `schema`), or `raw: true`. Both are
listed below. `tools[].input` and `output.schema` are ordinary JSON Schema (2020-12); their
limits are in [input and output](/docs/framework/input-output/#schemas-in-a-spec).

{{< spec-reference >}}

## Templates

Only two kinds of placeholders exist, `{{input.field}}` (nested: `{{input.user.id}}`) and
`{{secrets.NAME}}`. There is no logic, no filter and no expression; anything else is a load
error, and `\{{` writes a literal `{{`. Each value is encoded for where it goes: see
[HTTP tools](/docs/framework/http-tools/#templates).

## Editor support

The schema in the table above ships in `@kervan/spec-runtime` as
`schema/kervan.schema.json`. With the YAML extension of VS Code, point the file at it:

```yaml {check="fragment"}
# yaml-language-server: $schema=./node_modules/@kervan/spec-runtime/schema/kervan.schema.json
```

The schema's `$id`, `https://getkervan.dev/schema/v1.json`, is also where this site serves the
same file. Loading a spec never fetches anything: validation always uses the copy in the package.
