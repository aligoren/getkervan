---
title: Changelog
seoTitle: Kervan changelog, release notes
description: Release notes for Kervan's packages and Kervan Studio. Version 0.1 is a release candidate on npm, under the next tag; 0.1.0 follows under latest.
lead: Release notes, newest first.
excludeFromSearch: false
---

## 0.1.0-rc.2, release candidate

The first release that GitHub Actions publishes, through npm trusted publishing (with provenance),
under the `next` tag. No code changes from `0.1.0-rc.1`.

## 0.1.0-rc.1, release candidate

The first release, on npm under the `next` tag (`npm create kervan@next my-server`); `0.1.0`
follows under `latest`. It contains:

- `@kervan/core`, `@kervan/transport`, `@kervan/spec-runtime`, the `kervan` CLI and
  `create-kervan`, with the API listed in [programmatic API](/docs/framework/api/);
- the `kervan.yaml` format, `specVersion: 1`, and its editor schema at
  [/schema/v1.json](/schema/v1.json).

Kervan Studio stays in the repository; how it is distributed after 0.1 is not decided yet.
