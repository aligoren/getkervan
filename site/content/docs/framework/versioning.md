---
title: Versioning and upgrades
seoTitle: 'Kervan versioning, specVersion and upgrades'
description: How Kervan versions its packages and the kervan.yaml format; semver for stable exports from 0.1, specVersion and schema versions, and how to upgrade a project.
lead: What may change between releases, and how to upgrade.
weight: 150
---

## The packages

Kervan follows semantic versioning from 0.1 on. **Stable** exports change incompatibly only in a
new minor version while the version is 0.x, and the [changelog](/changelog/) says so.
**Experimental** exports may change in any release. The [programmatic API](/docs/framework/api/)
page lists which is which; anything not listed is internal, even when a deep import reaches it.

`@kervan/core`, `@kervan/transport`, `@kervan/spec-runtime`, `kervan` and `create-kervan` are
released together with the same version.

## The spec format

- `specVersion: 1` changes only compatibly. A breaking format would become `specVersion: 2`, and
  Kervan would say which it needs.
- The editor schema for version 1 is served at `https://getkervan.dev/schema/v1.json`; a version 2
  would get `schema/v2.json`, with `v1.json` left in place.
- Limits (`HTTP_DEFAULTS`, `SPEC_LIMITS`, `SCHEMA_LIMITS`) keep their names; their values may be
  tuned in minor releases.

## Upgrading a project

Read the [changelog](/changelog/) first. Until the packages are on npm, a project made with
`pnpm try:new` is upgraded by creating it again from a newer clone.

{{% published %}}
Upgrade the packages together:

```sh {check="manual" reason="needs the packages on npm"}
npm install @kervan/core@latest @kervan/transport@latest
npm install --save-dev kervan@latest
npm test
```
{{% /published %}}
