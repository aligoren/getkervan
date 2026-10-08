---
title: The data directory and the master key
seoTitle: 'Kervan Studio master key and data directory'
description: Kervan Studio keeps its data in one SQLite file and encrypts secrets with a master key you hold. Lose the key and stored secrets are gone; back up both, apart.
lead: Two things make a Studio installation, and you are responsible for keeping both.
weight: 20
---

{{< callout title="Lose the master key, lose the stored secrets" tone="warning" >}}
Studio encrypts every secret with `KERVAN_STUDIO_MASTER_KEY` (AES-256-GCM). The key is never
written to the database, and nothing can decrypt the secrets without it: not Studio, not the
project, not a database backup. If the key is lost, the stored secrets must be deleted and set
again. **Back up the key yourself**, apart from the database, before you store the first secret.
{{< /callout >}}

## What to keep

{{% include file="apps/studio/README.md" section="Data and backups" untilLine="To back up a running Studio" %}}

Studio refuses to start without a master key, and refuses to start when a stored secret does not
decrypt with the configured keys: it never runs with secrets it cannot use or protect. When the
data directory already holds secrets and the key is missing, it says to set the original key, not
to make a new one.

## Rotating the master key

{{% include file="apps/studio/README.md" section="Rotating the master key" %}}

## Backups

Backing up and restoring the database, and upgrading Studio, are on
[backup, restore and upgrades](/docs/studio/backup/).
