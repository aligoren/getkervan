---
title: CLI reference
seoTitle: kervan CLI reference, create, dev and run
description: The kervan command line, generated from its --help output; kervan create for new projects, kervan dev with hot reload and a REPL, kervan run to serve a spec.
lead: '`kervan create`, `kervan dev` and `kervan run`. The summary below is the real `--help` output.'
weight: 110
---

Until the packages are published, run the CLI from a clone as
`node packages/cli/bin/kervan.js <command>`; afterwards, `npx kervan <command>`. The CLI refuses
Node.js versions outside 22.23.3 or a later 22.x, or 24.21.0 or later, with one line.

{{< cli-help command="kervan" without="studio" >}}

## kervan create

{{% include file="packages/cli/README.md" section="`kervan create <dir>`" %}}

## kervan run

{{% include file="packages/cli/README.md" section="`kervan run <spec>`" %}}

## kervan dev

{{% include file="packages/cli/README.md" section="`kervan dev <entry>`" %}}
