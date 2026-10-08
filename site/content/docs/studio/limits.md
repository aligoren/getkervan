---
title: Known limits
seoTitle: 'Kervan Studio known limits'
description: 'What Kervan Studio does not do: one process, API keys instead of OAuth, no push to 2025-era HTTP clients, 100 audit entries, no sub-path.'
lead: Choices and gaps to know before you deploy Studio.
weight: 150
---

{{% include file="apps/studio/README.md" section="Known limits" %}}

## Also worth knowing

- **2025-era HTTP clients get no push.** Studio serves them statelessly, so they do not receive
  `list_changed`; they see a publish on their next `tools/list`. Clients on MCP 2026-07-28 that
  listen get it at once.
- **The audit page shows the latest 100 entries.** Older rows stay in the database.
- **Windows file permissions** are not set by Studio: keep the data directory where only the Studio
  user can read it.
- **Spec tools need https and public addresses.** There is deliberately no setting that lets them
  reach private or loopback addresses.

The [threat model](/docs/studio/security/#known-limits) lists the accepted security limits.
