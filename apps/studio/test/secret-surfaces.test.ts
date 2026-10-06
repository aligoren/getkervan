import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { listAudit } from "../src/db/repos/audit.js"
import { createWorkspace } from "../src/db/repos/workspaces.js"
import {
  connect,
  MODERN,
  spec,
  startTestStudio,
  startUpstream,
  type Upstream,
  user,
} from "./helpers.js"

// Characters that change under URL, form and JSON encoding.
const SECRET = 'sk-"surface"+/=&value 0123'
const FORMS = [
  SECRET,
  encodeURIComponent(SECRET),
  new URLSearchParams({ v: SECRET }).toString().slice(2),
  JSON.stringify(SECRET).slice(1, -1),
]

let upstream: Upstream
beforeAll(async () => {
  upstream = await startUpstream()
})
afterAll(() => upstream.close())

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe("a secret value never comes back out of Studio", () => {
  it("is absent from results, errors, raw responses, logs, export, audit, bindings and the database", async () => {
    const t = await startTestStudio()
    cleanups.push(t.close)
    const scope = createWorkspace(t.database.db, "w")
    const server = t.studio.createServer(scope, { slug: "s", name: "S" }, user())
    const base = `http://api.test:${upstream.port}`
    t.secrets.set(scope, server.id, {
      name: "API_KEY",
      value: SECRET,
      allowedHosts: [`api.test:${upstream.port}`],
    })
    const text = spec(
      `
  - name: reflect
    description: The upstream echoes the key and query back
    http:
      url: ${base}/echo/reflect
      query: { k: "{{secrets.API_KEY}}" }
      headers: { X-Key: "{{secrets.API_KEY}}" }
    output: { select: "@" }
  - name: raw
    description: Same, as raw text
    http: { url: "${base}/echo/raw", headers: { X-Key: "{{secrets.API_KEY}}" } }
    output: { raw: true }
  - name: failing
    description: The secret is in the path of a request that fails (logged)
    http: { url: "${base}/fail/{{secrets.API_KEY}}", headers: { X-Key: "{{secrets.API_KEY}}" } }
    output: { select: "@" }`,
      "secrets: [API_KEY]",
    )
    const version = t.studio.saveVersion(scope, server.id, text, user())
    await t.studio.publish(scope, server.id, version.id, user())
    const { key } = t.studio.createApiKey(scope, server.id, "k", user())
    const mcpUrl = new URL(`/s/${server.id}/mcp`, t.url)

    const surfaces: Record<string, string> = {}
    for (const era of ["modern", "legacy"] as const) {
      const client = await connect(mcpUrl, key, era)
      cleanups.push(() => client.close())
      for (const name of ["reflect", "raw", "failing"]) {
        surfaces[`${era} ${name}`] = JSON.stringify(
          await client.callTool({ name, arguments: {} }).catch((error: unknown) => String(error)),
        )
      }
      surfaces[`${era} list`] = JSON.stringify(await client.listTools())
    }
    // The bytes on the wire, not just what the SDK client parsed.
    const raw = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN,
        "mcp-method": "tools/call",
        "mcp-name": "reflect",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "reflect",
          arguments: {},
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    })
    surfaces["raw response"] = `${JSON.stringify([...raw.headers])}${await raw.text()}`
    surfaces.logs = t.logger.lines.join("\n")
    surfaces.export = await t.studio.exportVersion(scope, server.id, version.id)
    surfaces.audit = JSON.stringify(listAudit(t.database.db, scope))
    surfaces.bindings = JSON.stringify(await t.secrets.list(scope, server.id))
    surfaces.validation = JSON.stringify(await t.studio.validate(scope, server.id, version.id))
    const tables = t.database.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
    surfaces.database = tables
      .map(({ name }) => JSON.stringify(t.database.sqlite.prepare(`SELECT * FROM "${name}"`).all()))
      .join("\n")

    // The secret did reach the upstream (it was used), and the results did contain it before
    // redaction (the upstream reflects it): the checks below are not vacuous.
    expect(upstream.requests.some((request) => request.headers["x-key"] === SECRET)).toBe(true)
    expect(surfaces["modern reflect"]).toContain("[redacted]")
    expect(surfaces.logs).toContain("returned 500")

    for (const [surface, content] of Object.entries(surfaces)) {
      for (const form of FORMS) expect(content, `${surface} holds the secret`).not.toContain(form)
    }
  })
})

describe("a secret value never comes back out of the management API (4c)", () => {
  it("is absent from every API response, the logs with payloads, and the encrypted database", async () => {
    const { apiStudio, gatewayClient } = await import("./api-helpers.js")
    const s = apiStudio()
    cleanups.push(s.close)
    await s.addUser("admin@example.test", "admin")
    const admin = await s.signIn("admin@example.test")
    const server = (
      await s.request("POST", "/api/servers", { ...admin, body: { slug: "s", name: "S" } })
    ).json.server as { id: string }
    const id = server.id
    const host = `api.test:${upstream.port}`
    expect(
      (
        await s.request("PUT", `/api/servers/${id}/secrets/API_KEY`, {
          ...admin,
          body: { value: SECRET, allowedHosts: [host] },
        })
      ).status,
    ).toBe(200)
    const yaml = spec(
      `
  - name: reflect
    description: The upstream echoes the key back
    input: { type: object, properties: { note: { type: string } } }
    http:
      url: http://${host}/echo/api-surface
      query: { k: "{{secrets.API_KEY}}" }
      headers: { X-Key: "{{secrets.API_KEY}}" }
    output: { select: "@" }`,
      "secrets: [API_KEY]",
    )
    const saved = await s.request("POST", `/api/servers/${id}/versions`, {
      ...admin,
      body: { yaml },
    })
    const versionId = (saved.json.version as { id: string }).id
    await s.request("POST", `/api/servers/${id}/versions/${versionId}/publish`, {
      ...admin,
      body: {},
    })
    await s.request("PUT", `/api/servers/${id}/settings`, { ...admin, body: { logPayloads: true } })
    const created = await s.request("POST", `/api/servers/${id}/keys`, {
      ...admin,
      body: { name: "k" },
    })
    const client = await gatewayClient(s, id, String(created.json.key), cleanups)
    const result = await client.callTool({ name: "reflect", arguments: { note: "hello" } })
    expect(upstream.requests.at(-1)?.headers["x-key"]).toBe(SECRET)
    expect(JSON.stringify(result)).toContain("[redacted]")

    const surfaces: Record<string, string> = { "tool result": JSON.stringify(result) }
    for (const path of [
      "/api/me",
      "/api/servers",
      `/api/servers/${id}`,
      `/api/servers/${id}/versions/${versionId}`,
      `/api/servers/${id}/versions/${versionId}/export`,
      `/api/servers/${id}/versions/${versionId}/diff/${versionId}`,
      `/api/servers/${id}/secrets`,
      `/api/servers/${id}/keys`,
      `/api/servers/${id}/logs`,
      "/api/audit",
      "/api/users",
    ]) {
      const response = await s.request("GET", path, admin)
      expect(response.status, path).toBe(200)
      surfaces[path] = `${JSON.stringify([...response.headers])}${response.text}`
    }
    surfaces["studio log"] = s.logger.lines.join("\n")
    const tables = s.database.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
    surfaces.database = tables
      .map(({ name }) => JSON.stringify(s.database.sqlite.prepare(`SELECT * FROM "${name}"`).all()))
      .join("\n")
    // The payload log exists (the check below is not vacuous).
    expect(surfaces[`/api/servers/${id}/logs`]).toContain("hello")

    for (const [surface, content] of Object.entries(surfaces)) {
      for (const form of FORMS) expect(content, `${surface} holds the secret`).not.toContain(form)
    }
  })
})
