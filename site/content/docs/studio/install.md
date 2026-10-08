---
title: Install and the first admin
seoTitle: 'Install Kervan Studio and the first admin'
description: Run Kervan Studio from a clone, set the master key, create the first admin with the one-time setup token or the create-admin command, and sign in.
lead: Studio runs from a clone of the repository. Until the first admin exists, it listens on 127.0.0.1 only.
weight: 10
---

## Requirements

- Node.js **22.23.3 or a later 22.x, or 24.21.0 or later**. Studio refuses anything else with one
  line, before it loads.
- pnpm (through `corepack enable`), Git, and a place for the data directory that only the Studio
  user can read.

## Build and start

{{< clone >}}

Create a master key once, and keep it somewhere safe **outside** the data directory (a password
manager, a secret store). Read [the data directory and the master key](/docs/studio/data-and-master-key/)
first: without the key, stored secrets cannot be recovered.

This writes a new key into `.env.studio` without showing it, and refuses to overwrite an existing
file. Copy the key from the file to your password manager:

```sh {check="studio-key"}
node -e "require('fs').writeFileSync('.env.studio', 'KERVAN_STUDIO_MASTER_KEY=' + require('crypto').randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' })"
```

Then start Studio with it. Node reads the file (`--env-file`), so the key is never on the command
line or in your shell history:

```sh {check="studio-starts"}
node --env-file=.env.studio apps/studio/bin/kervan-studio.js start
```

Both commands are the same in PowerShell and cmd. The repository's `.gitignore` keeps `.env.*`
files out of Git. On Windows the file mode does not apply: keep the folder private.

The database goes into `.kervan-studio/` in the current folder (`KERVAN_STUDIO_DATA_DIR` changes
it). A folder Studio creates gets a `.gitignore` that keeps it out of Git, and Studio warns at
start when Git could still commit the database.

## The first admin, in the browser

On the first start, Studio listens on `127.0.0.1` only, whatever `KERVAN_STUDIO_HOST` says, and
prints a one-time setup token, valid for 30 minutes (a restart prints a new one and invalidates the
old one). Open `http://127.0.0.1:4310/setup`, paste the token, and choose the admin's email and
password (at least 12 characters).

{{< shot name="setup" alt="The setup page: fields for the one-time setup token, the admin's email and password." >}}

Once the admin exists, Studio also listens on `KERVAN_STUDIO_HOST`.

## The first admin, from the shell

{{% include file="apps/studio/README.md" section="Creating the first admin from the shell" %}}

## Locked out

{{% include file="apps/studio/README.md" section="Recovering admin access" %}}

## Next

[Configuration and reverse proxies](/docs/studio/configuration/) for a server on the network, then
[create your first server](/docs/studio/servers/).
