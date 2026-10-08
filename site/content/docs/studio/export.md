---
title: Leaving Studio, export as kervan.yaml
seoTitle: 'Export a Studio server as kervan.yaml'
description: Every Kervan Studio server exports as a kervan.yaml file that runs with kervan run, with its secret bindings and without secret values; nothing is locked in.
lead: Nothing in Studio is locked in. Any version exports as the `kervan.yaml` it is, and runs with `kervan run`.
weight: 170
---

## Export a version

On the server's editor, the download button (**Export kervan.yaml**) saves the selected version
as it was written, comments included, except that each `secrets` entry carries the hosts Studio
allows for it (the spec's own hosts, narrowed to the vault's binding). Secret **values** are never
exported.

## Run it without Studio

Provide the secrets as environment variables or an env file, and serve the file with the
framework's CLI:

```sh {check="manual" reason="runs an exported spec with real secrets"}
node packages/cli/bin/kervan.js run kervan.yaml --env-file .env
```

The same checks apply outside Studio: a secret bound to hosts is refused for other hosts when the
spec loads, and never travels over plain http. The [framework documentation](/docs/framework/)
covers serving it over HTTP, deployment and connecting clients.
