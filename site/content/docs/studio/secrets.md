---
title: The secret vault
seoTitle: 'Kervan Studio secret vault for API keys'
description: Kervan Studio stores upstream API keys encrypted and write-only, bound to the hosts they may be sent to, and checks every call and redirect against the binding.
lead: Secrets are encrypted, write-only, and bound to the hosts they may reach. Members use them by name and never see a value.
weight: 60
group: Servers
---

{{< shot name="secrets" alt="The secrets tab: ISSUES_TOKEN and WEBHOOK_SIGNING_KEY, each with its allowed host and the time it was updated; no value is shown." >}}

## Add a secret

Admins add secrets per server, on the **Secrets** tab: a name (`A-Z`, `0-9`, `_`), a value of at
least 8 characters, and the hosts it may be sent to (`host` or `host:port`, port 443 when
omitted). The value is encrypted with the [master key](/docs/studio/data-and-master-key/) and never
shown again, not even to admins.

A spec uses it by name, and may narrow its hosts further, never widen them:

```yaml {check="fragment"}
secrets:
  - name: ISSUES_TOKEN
    hosts: [api.issues.example.com]
```

## Where a secret may go

The vault's binding decides; a spec can only narrow it. Studio checks it three times: when a
version is published, when the spec loads, and before every request and every redirect hop. A
redirect to a host the secret may not reach is not followed. A secret never travels over plain
`http`.

## Rotate, rebind, delete

- **Rotate:** set a new value. The next call uses it; the old value stays redacted wherever the
  server saw it.
- **Rebind:** change the hosts. A narrower binding applies at the next call.
- **Delete:** if the published version uses the secret, Studio lists the tools that do and asks for
  confirmation. Afterwards those tools fail with "Secret X is not configured for host:port", and
  nothing is sent.

Every change is in the [audit log](/docs/studio/audit/), with names and hosts, never values.
