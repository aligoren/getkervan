---
title: Publish, roll back and disable
seoTitle: Publish and roll back MCP servers in Kervan Studio
description: Publishing a version in Kervan Studio updates the gateway in place; roll back by publishing an older version, or disable a server without deleting anything.
lead: Publishing changes what MCP clients see, at once and in place.
weight: 50
---

## Publish

**Publish v*N*** validates the version strictly, including that every secret it uses exists and
may be sent to the host each tool calls, then points the server at it. The gateway's tool set
changes in place: clients on MCP 2026-07-28 that listen get `list_changed` at once; 2025-era
clients, served statelessly over HTTP, see the new tools on their next `tools/list`.

A refused publish says which tools and lines are wrong, and is recorded in the audit log as
`server.publish_refused` (it can be an attempt to send a secret elsewhere).

## Roll back

Publish an older version again. Connected clients are told the same way, and the audit log records
a `server.rollback`.

## Disable a server

**Disable server** takes it offline without deleting anything: its endpoint answers 404 like an
unknown server, open connections and playground sessions close, and versions, secrets, keys and
call logs stay. **Enable server** serves the published version again with the same keys. Both ask
for confirmation and are audited. Any signed-in user may do it, as for publishing.

## Delete a server

Admins only. Deleting removes the server with its versions, secrets, keys and call logs, and ends
its connections. The audit log keeps the record.
