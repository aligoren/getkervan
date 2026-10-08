---
title: Troubleshooting
seoTitle: 'Troubleshooting Kervan Studio'
description: Common Kervan Studio problems; it does not start, the setup page is unreachable, sign-in is locked, clients get 401 or 404, or a publish is refused.
lead: What the usual messages mean and what to do.
weight: 160
---

## Studio does not start

- **"KERVAN_STUDIO_MASTER_KEY is not set":** set it. If the message says the data directory already
  holds encrypted secrets, set the key it was set up with, not a new one.
- **"Secret X ... cannot be decrypted":** the configured keys do not match the database. Set the
  right `KERVAN_STUDIO_MASTER_KEY`, and older ones in `KERVAN_STUDIO_PREVIOUS_MASTER_KEYS`.
- **"Kervan Studio needs Node.js ...":** upgrade Node.js to 22.23.3 or a later 22.x, or 24.21.0 or
  later.
- **The port is in use:** Studio says so in one line; set `KERVAN_STUDIO_PORT`.
- **A migration failed, or the database is newer:** restore the backup made before the upgrade, or
  run the newer Studio.

## The setup page cannot be reached

Before the first admin exists, Studio listens on `127.0.0.1` only. From another machine, or in a
container, create the first admin with `create-admin` instead; see
[install](/docs/studio/install/#the-first-admin-from-the-shell).

## Sign-in is refused

Five failed attempts for an account, or twenty from an address, lock it for 15 minutes. If an admin
password is lost, use `reset-admin` on the host; a lock already in effect lasts until it expires or
Studio restarts.

## A client gets 401, 403 or 404

- **401:** the key is missing, wrong, revoked or for another server. The answer is the same for all
  four, on purpose.
- **403:** the request has an `Origin` that is not Studio's public URL, or a `Host` that is not its
  host name. Check `KERVAN_STUDIO_PUBLIC_URL` and that the proxy keeps the `Host` header.
- **404:** the server is not published, disabled or deleted.

## A publish is refused

The message lists each problem with its line. Usual causes: a secret the version uses does not
exist, or may not be sent to the host a tool calls; a tool sends a secret to an `http://` URL; a
field is misspelled.
