---
title: Audit log
seoTitle: Kervan Studio audit log, who changed what and when
description: Kervan Studio's append-only audit log records sign-ins, user changes, servers, publishes, secrets and API keys; never a password, key or secret value.
lead: Who did what, to what, from where. The database refuses to change or delete entries, and the log never holds a secret.
weight: 100
---

{{< shot name="audit" alt="The audit log: API keys, secrets and servers created, versions published, sign-ins and a user deactivated, each with the actor and the client address." >}}

## What is recorded

- Sign-ins (successful and failed, with the client address), sign-outs, ended sessions.
- Users: created, role and email changes, password resets and changes, profile and theme changes,
  deactivation and reactivation. The command-line tools (`create-admin`, `reset-admin`) appear as
  the actor `cli`.
- Servers: created, deleted, published, rolled back, refused publishes, settings, disabled and
  enabled.
- Secrets (created, rotated, rebound, deleted) and API keys (created, revoked).

Not recorded: saving a version (versions keep their author) and playground use (the call log has
it).

## Guarantees and limits

- Rows cannot be changed or deleted: database triggers refuse it.
- Details hold names, ids, hosts and counts; never a password, a secret value, a key or a token.
- Only admins read the log. The page shows **the latest 100 entries**.
- A failed sign-in's email is kept as typed, with any hidden character shown as a visible escape.
