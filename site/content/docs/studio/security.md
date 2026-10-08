---
title: Security and threat model
seoTitle: 'Kervan Studio threat model and mitigations'
description: 'Kervan Studio''s full threat model: actors, assets, the attacks it is designed against, from secret exfiltration and SSRF to CSRF, and known limits.'
lead: The complete threat model of Studio, the same document the project keeps in its repository. Every mitigation it lists is covered by tests.
weight: 140
---

In short:

- Secrets are encrypted, write-only, bound to hosts, and redacted from everything a tool returns.
- Spec tools reach public addresses only, never Studio itself or cloud metadata services.
- The web UI shows untrusted text as text only, under a strict Content Security Policy; every change
  needs the exact origin, a JSON body and a CSRF token.
- Sessions, roles, the playground and the gateway are each checked on every request, and every
  write checks again that its author may still make it.

To report a vulnerability, write to [security@getkervan.dev](mailto:security@getkervan.dev)
privately; see the [security model](/docs/framework/security/#reporting-a-vulnerability).

{{% include file="docs/THREAT-MODEL-STUDIO.md" %}}
