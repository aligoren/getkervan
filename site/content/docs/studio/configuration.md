---
title: Settings and configuration
seoTitle: 'Configure Kervan Studio: settings and env'
description: 'Kervan Studio''s settings page and environment variables: public URL, host, port, data directory, master keys, proxies and log retention.'
lead: The settings page holds per-user choices; the installation is configured with environment variables.
weight: 120
group: Operate
---

## The settings page

{{< shot name="settings" alt="The settings page: the appearance choice (System, Light, Dark) and how to connect clients." >}}

**Settings** has your theme and how clients connect. Per-server settings live on the server: logging
call payloads is on the [Calls](/docs/studio/call-logs/) tab.

## Environment variables

{{% include file="apps/studio/README.md" section="Configuration" %}}

## Behind a reverse proxy

{{% include file="apps/studio/README.md" section="Behind a reverse proxy" %}}
