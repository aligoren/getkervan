---
title: CLI reference
seoTitle: kervan CLI reference, create, dev and run
description: The kervan command line, generated from its --help output; kervan create for new projects, kervan dev with hot reload and a REPL, kervan run to serve a spec.
lead: '`kervan create`, `kervan dev` and `kervan run`. The summary below is the real `--help` output, minus one line about the optional web UI.'
weight: 80
group: Run and operate
fits: 'Run and operate. The command line that creates projects and serves specs and code.'
next:
  - url: /docs/framework/deployment/
    text: 'Deployment'
  - url: /docs/framework/troubleshooting/
    text: 'Troubleshooting'
---

Until the packages are published, run the CLI from a clone as
`node packages/cli/bin/kervan.js <command>`; afterwards, `npx kervan <command>`. The CLI refuses
Node.js versions outside 22.23.3 or a later 22.x, or 24.21.0 or later, with one line.

{{< cli-help command="kervan" without="studio" >}}

## kervan create

{{< unpublished >}}
{{< callout title="Before the packages are on npm" tone="warning" >}}
`kervan create` installs `@kervan/core`, `@kervan/transport` and `kervan` from the npm registry,
where they are not published yet: the install fails, or, once someone else registers those names,
installs their packages. Until the release, use `pnpm try:new <dir>` from a clone, which installs
the packages built from that clone ([quickstart](/docs/framework/quickstart/)), or pass
`--no-install`.
{{< /callout >}}
{{< /unpublished >}}

{{% include file="packages/cli/README.md" section="`kervan create <dir>`" %}}

## kervan run

{{% include file="packages/cli/README.md" section="`kervan run <spec>`" %}}

## kervan dev

{{% include file="packages/cli/README.md" section="`kervan dev <entry>`" %}}
