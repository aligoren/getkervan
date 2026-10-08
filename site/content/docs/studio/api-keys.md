---
title: API keys, the gateway and connecting
seoTitle: 'Connect MCP clients to Kervan Studio'
description: Every published Kervan Studio server is an MCP endpoint at /s/<serverId>/mcp. Create an API key, connect Claude Code with bash, zsh or PowerShell, revoke keys.
lead: Each published server is served at `/s/<serverId>/mcp`. Clients authenticate with one of that server's API keys.
weight: 70
group: Servers
menuTitle: 'API keys and gateway'
---

{{< shot name="keys" alt="The API keys tab: three keys with their names, prefixes, creation and last-use times, and a Revoke button each." >}}

## Create a key

Admins create keys on the **API keys** tab. A key is `kvn_` plus 32 random bytes; it is shown
**once**, with ready-made commands to add the server to Claude Code, and Studio keeps only its
SHA-256. The list shows each key's prefix and last use.

{{< shot name="connect-key" alt="The new-key dialog: the key in a read-only field and the claude mcp add command with the key in it." caption="The key itself appears in this dialog only (shown here with a placeholder)." >}}

The command with the key in it is the quickest, but leaves the key in your shell's history. The
**bash / zsh** and **PowerShell** tabs read the key without echoing it and pass it through a
variable:

{{< shot name="connect-bash" alt="The bash / zsh tab: a command that reads the key hidden into a variable, adds the server and unsets the variable." >}}

{{% include file="apps/studio/README.md" section="Gateway" %}}

## Revoke a key

**Revoke** asks for confirmation and takes effect on the next request; the key's open streams are
closed at once. Deactivating the user who created a key can revoke their keys in the same step.

For another client, or for the protocol details, see the guide to
[connecting a server to Claude Code](/guides/connect-claude-code/) and the
[MCP protocol notes](/docs/framework/protocol/).
