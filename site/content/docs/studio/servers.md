---
title: Create and edit servers
seoTitle: 'Edit MCP servers in Kervan Studio'
description: Create a server in Kervan Studio, write its kervan.yaml in the editor with completion and validation, save immutable versions and compare them line by line.
lead: A server is a slug, a name and a history of `kervan.yaml` versions. One of them is published.
weight: 40
group: Servers
---

## Create a server

**Servers, Create server**: a name, and a slug of `a-z`, `0-9` and `-` that appears in commands and
file names. A new server shows a "Next steps" list until it is set up: a valid version, the
secrets it uses, publishing, an API key, and connecting a client.

## The editor

{{< shot name="editor" alt="The editor tab of the weather server: the published kervan.yaml with line numbers, the Save and Publish buttons, and the playground beside it." >}}

The editor knows the spec's schema: it completes field names and marks problems as you type.
**Save as new version** stores the text as a new, immutable version, even when it has problems;
problems are listed with line and column, and a version with problems cannot be published.

{{< shot name="validation" alt="A draft with a misspelled field, timeoutMS, underlined in the editor; the Publish button is disabled." caption="A misspelled field is marked in the editor, and publishing the draft is refused." >}}

The spec format is the framework's; the [kervan.yaml reference](/docs/framework/spec-reference/)
documents every field. Studio adds one rule of its own: a tool that sends a secret must call an
`https` URL.

## Versions

{{< shot name="versions" alt="The versions tab: two versions with their authors and dates, the published one marked live, and buttons to compare and publish." >}}

The **Versions** tab lists every version with its author and check result. Compare any two line
by line, open one in the editor, or publish an older one to [roll back](/docs/studio/publishing/).
Versions are never changed or deleted (database triggers refuse it), except with their server.
