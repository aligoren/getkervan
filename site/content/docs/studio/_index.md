---
title: Kervan Studio documentation
navTitle: Kervan Studio
seoTitle: 'Kervan Studio: self-hosted MCP gateway'
description: 'Kervan Studio is an optional self-hosted web app to write, publish and serve kervan.yaml MCP servers for a team, with a secret vault and audit.'
lead: An optional, self-hosted web app for teams. It is built on the Kervan framework and adds nothing the framework depends on.
weight: 1
cascade:
  ogSection: Kervan Studio documentation
menuTitle: Introduction
groups: [Start, Servers, People and logs, Operate]
group: Start
---

{{< shot name="servers" alt="Studio's server list: three servers with their publication status, the newest draft's check and the time of the last call." >}}

## What it is

Kervan Studio runs as one Node.js process with one SQLite database. People sign in with a browser
and:

- write `kervan.yaml` specs in an editor with completion and validation;
- keep upstream API keys in an encrypted, write-only vault, bound to the hosts they may reach;
- publish versions, roll back, or take a server offline;
- try any version in a playground;
- give MCP clients one gateway, `/s/<serverId>/mcp`, with per-server API keys;
- see call logs and an append-only audit log.

## When you need it, and when you do not

You do not need Studio to run Kervan servers: `kervan run kervan.yaml` serves a spec on its own,
and a spec in a Git repository already has versions and review. Studio is for when several people
manage several servers, when API keys should live in one vault instead of on laptops, or when
non-developers write specs.

**Nothing is locked in.** Every server exports as a `kervan.yaml` that runs with `kervan run`; see
[leaving Studio](/docs/studio/export/).

## Status

Studio is in development and not published: it runs from a clone of the repository. It is private
in the repository's workspace and is not an npm package.

## Start here

1. [Install and the first admin](/docs/studio/install/)
2. [The data directory and the master key](/docs/studio/data-and-master-key/): read this before
   you store a secret.
3. [Create and edit a server](/docs/studio/servers/), then [publish it](/docs/studio/publishing/)
   and [connect a client](/docs/studio/api-keys/).
