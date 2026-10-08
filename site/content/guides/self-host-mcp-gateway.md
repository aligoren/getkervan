---
title: Self-host a multi-user MCP gateway
seoTitle: 'Self-host a multi-user MCP gateway'
description: 'Run Kervan Studio as a self-hosted MCP gateway for a team: install, master key, first admin, a published server, an API key and Claude Code.'
lead: One Studio process gives a team a shared set of MCP servers behind one gateway, with users, an encrypted secret vault and an audit log. This guide goes from nothing to a connected client.
weight: 50
---

Kervan Studio is the optional web app of the Kervan project. Everything below ran on a fresh data
directory; the screenshots come from that run.

## 1. Build and start

{{< clone >}}

Create a master key and keep it outside the data directory. Without it, stored secrets cannot be
recovered ([why](/docs/studio/data-and-master-key/)).

```sh {check="run"}
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

```sh {check="studio-starts"}
KERVAN_STUDIO_MASTER_KEY=<that key> node apps/studio/bin/kervan-studio.js start
```

## 2. The first admin

Studio prints a one-time setup token and listens on `127.0.0.1:4310` only. Open
`http://127.0.0.1:4310/setup` and create the admin, or do it from the shell (also how it works in
a container):

```sh {check="studio-create-admin"}
node apps/studio/bin/kervan-studio.js create-admin --email admin@example.com
```

It asks for the password twice without showing it. Studio then listens on `KERVAN_STUDIO_HOST`.

## 3. Put it behind HTTPS

For a team, run Studio behind a TLS proxy with its public URL. With Caddy on the same machine:

```caddyfile {check="manual" reason="needs a public DNS name for the certificate"}
studio.example.com {
	reverse_proxy 127.0.0.1:4310
}
```

```sh {check="manual" reason="needs the proxy above"}
KERVAN_STUDIO_PUBLIC_URL=https://studio.example.com KERVAN_STUDIO_TRUST_PROXY=1 KERVAN_STUDIO_MASTER_KEY=<that key> node apps/studio/bin/kervan-studio.js start
```

Details and the other settings: [configuration](/docs/studio/configuration/).

## 4. A server, its secrets, published

Create a server, paste or write its `kervan.yaml`, save, and publish. Secrets the spec uses are
added by an admin on the **Secrets** tab, bound to the hosts they may reach.

{{< shot name="editor" alt="The weather server's editor with its kervan.yaml, published as version 2, and the playground beside it." >}}

Try it in the [playground](/docs/studio/playground/) before anyone connects.

## 5. An API key, and a client

On **API keys**, create a key for the server. Studio shows it once, with commands that add the
server to Claude Code; the bash/zsh and PowerShell versions read the key without echoing it.

{{< shot name="connect-powershell" alt="The PowerShell tab of the new-key dialog: Read-Host reads the key as a secure string, claude mcp add uses it, then the variable is removed." >}}

```sh {check="manual" reason="needs a running Studio with a published server and a key"}
claude mcp add --transport http weather https://studio.example.com/s/<serverId>/mcp \
  --header "Authorization: Bearer $KERVAN_API_KEY"
```

## 6. Add the team

Admins add people on **Users**: members write and publish specs, admins also manage people,
secrets and keys. See [users and roles](/docs/studio/users/).

## What you get

- One endpoint per server, `/s/<serverId>/mcp`, with per-server keys you can revoke.
- [Call logs](/docs/studio/call-logs/) and an [audit log](/docs/studio/audit/).
- No lock-in: every server [exports as `kervan.yaml`](/docs/studio/export/).
