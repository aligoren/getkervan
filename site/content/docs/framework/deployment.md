---
title: Deployment
seoTitle: 'Deploy a Kervan MCP server: Docker and proxies'
description: Run a Kervan MCP server in production; supported Node.js versions, a Dockerfile draft for a spec server, binding and allowed hosts, a TLS reverse proxy.
lead: A spec server or a TypeScript server is one Node.js process. This page covers the runtime, a container and a proxy in front.
weight: 85
group: Run and operate
fits: 'Run and operate. From a working server to one others can reach; [security](/docs/framework/security/) covers what to check.'
next:
  - url: /docs/framework/security/
    text: 'Security model'
  - url: /docs/framework/troubleshooting/
    text: 'Troubleshooting'
---

## Node.js

Kervan's CLI and generated projects need Node.js **22.23.3 or a later 22.x, or 24.21.0 or later**:
the oldest releases its whole test suite passed on. Earlier 24.x releases crash intermittently on
Windows (a libuv bug), and Node.js 22.0 to 22.12 name the permission model the `select` sandbox
relies on differently and were never tested. The libraries alone declare Node.js 22 or newer.

Spec tools need Node.js (they pin DNS with `node:dns` and `node:http`). Tools written in code can
also be served by `toFetchHandler`, a standard fetch handler; it is tested on Node only, not on
Workers, Deno or Bun. See [transports](/docs/framework/transports/#a-fetch-handler).

## A container (draft)

This image builds Kervan from a clone of the repository (the code you build is the code you run)
and serves a spec. Put this `Dockerfile` at the repository root, with your spec in `deploy/kervan.yaml`:

```dockerfile {check="docker" id="spec-server"}
# syntax=docker/dockerfile:1
# A spec server built from source. Pin the base image by digest before using it.
FROM node:24-bookworm-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NODE_ENV=production
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
COPY deploy/kervan.yaml /srv/kervan.yaml
USER node
EXPOSE 3000
CMD ["node", "packages/cli/bin/kervan.js", "run", "/srv/kervan.yaml", "--http", "--host", "0.0.0.0", "--allowed-host", "mcp.example.com"]
```

```sh {check="docker-run" id="spec-server"}
docker build -t my-mcp-server .
docker run --rm -p 127.0.0.1:3000:3000 --read-only --cap-drop ALL my-mcp-server
```

- Add a `.dockerignore` with `node_modules`, `**/node_modules`, `.git` and `**/dist`, so the build
  starts from the sources only.
- `--allowed-host` is required off loopback: `kervan run` refuses to start without it. Use the
  host name clients put in the URL.
- `NODE_ENV=production` makes `kervan run` refuse the development flags
  (`--allow-private-network`, `--allow-insecure-secrets`).
- Secrets go in with `--env-file` or `-e NAME` from your secret store, never baked into the image.

## Behind a reverse proxy

Terminate TLS at a proxy and keep the server on loopback or a private network. With
[Caddy](https://caddyserver.com), which obtains certificates itself and streams
`text/event-stream` responses without buffering:

```caddyfile {check="manual" reason="needs a public DNS name for the certificate"}
mcp.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

```sh {check="starts" ready="Serving open-meteo"}
node packages/cli/bin/kervan.js run examples/spec/kervan.yaml --http --allowed-host mcp.example.com
```

The proxy must keep the original `Host` header (Caddy does). Kervan's per-client rate limit is keyed
by the socket address, which behind a proxy is the proxy's: rely on the proxy's rate limiting, or
key the limiter yourself in code (`rateLimit.keyGenerator`).
