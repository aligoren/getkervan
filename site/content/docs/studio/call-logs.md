---
title: Call logs
seoTitle: Kervan Studio call logs, who called which MCP tool
description: Kervan Studio logs every tool call through its gateway with tool, caller, status and duration; arguments and results only if an admin enables it, redacted.
lead: Every call through the gateway is logged. Payloads are logged only when an admin turns them on.
weight: 100
group: People and logs
---

{{< shot name="calls" alt="The calls tab: five recent calls of the weather server with time, tool, caller, status, duration and the logged arguments." >}}

## What is logged

- Always: the time, the tool, the caller (the playground, or the API key by name; never the key
  itself), the status, the duration and the version.
- Only when an admin checks **Also log arguments and results** for the server: the arguments and
  the result, redacted with the server's secrets and cut to 4 KiB each. Only admins see them;
  members see the call metadata.

Call logs are kept for `KERVAN_STUDIO_LOG_RETENTION_DAYS` days (30 by default) and deleted at
start and every hour after that.
