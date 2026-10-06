// Multi-tenant HTTP: each API key belongs to a tenant, and each tenant has its own tool set.
// The tenant comes from the verified credential, never from a client-chosen header or path.
import { type AuthInfo, createApp, InMemoryToolRegistry, type ToolRegistry } from "@kervan/core"
import { serveHttp } from "@kervan/transport/node"

// Demo data. In a real deployment keys are hashed and stored, and registries come from a database.
const API_KEYS: Record<string, { clientId: string; tenant: string }> = {
  "demo-key-acme": { clientId: "acme-app", tenant: "acme" },
  "demo-key-globex": { clientId: "globex-app", tenant: "globex" },
}

const acme = new InMemoryToolRegistry()
acme.add("acme_status", { description: "Acme system status", handler: () => "all green" })
const globex = new InMemoryToolRegistry()
globex.add("globex_status", { description: "Globex system status", handler: () => "nominal" })
// Same tenant → same registry object, so its handler and subscriptions are reused.
const registries: Record<string, ToolRegistry> = { acme, globex }

const app = createApp({ name: "kervan-tenants", version: "0.1.0" })

const server = await serveHttp(app, {
  port: Number(process.env.PORT ?? 3000),
  authenticate: (request): AuthInfo | Response => {
    const key = request.headers.get("x-api-key") ?? ""
    const account = API_KEYS[key]
    if (!account) return new Response(null, { status: 401 })
    return { token: key, clientId: account.clientId, scopes: [], extra: { tenant: account.tenant } }
  },
  resolveServer: (_request, { auth }) => registries[String(auth?.extra?.tenant)] ?? null,
})
app.logger.info(`multi-tenant server on ${server.url.href}`)

// Show that tenant tool sets change independently at runtime.
setTimeout(() => {
  acme.add("acme_deploy", { description: "Deploys Acme", handler: () => "deployed" })
  app.logger.info("added acme_deploy to the acme tenant")
}, 5_000)
