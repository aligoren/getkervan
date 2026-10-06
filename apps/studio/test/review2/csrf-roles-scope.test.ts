// Independent review: CSRF and cross-origin checks on every state-changing route, role checks on
// every admin-only route, and workspace/server scoping of every route parameter.
import { afterEach, describe, expect, it } from "vitest"
import { csrfTokenFor } from "../../src/api/routes.js"
import { hashPassword } from "../../src/crypto.js"
import { listAudit } from "../../src/db/repos/audit.js"
import { createSession } from "../../src/db/repos/sessions.js"
import { createUser } from "../../src/db/repos/users.js"
import { createWorkspace } from "../../src/db/repos/workspaces.js"
import { type ApiStudio, apiStudio, ORIGIN, PASSWORD } from "../api-helpers.js"

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

const SPEC = `specVersion: 1
name: scoped
version: 1.0.0
secrets: [API_KEY]
tools:
  - name: t
    description: d
    http:
      url: https://api.example.test/x
      headers: { X-Key: "{{secrets.API_KEY}}" }
    output: { select: "@" }
`

type Session = { cookie: string; csrf: string }

async function setup() {
  const s = apiStudio()
  studios.push(s)
  await s.addUser("admin@example.test", "admin")
  await s.addUser("member@example.test", "member")
  const admin = await s.signIn("admin@example.test")
  const member = await s.signIn("member@example.test", PASSWORD, "203.0.113.9")
  const mkServer = async (slug: string) => {
    const created = await s.request("POST", "/api/servers", {
      ...admin,
      body: { slug, name: slug },
    })
    const id = (created.json.server as { id: string }).id
    const saved = await s.request("POST", `/api/servers/${id}/versions`, {
      ...admin,
      body: { yaml: SPEC },
    })
    const vid = (saved.json.version as { id: string }).id
    await s.request("PUT", `/api/servers/${id}/secrets/API_KEY`, {
      ...admin,
      body: { value: "sk-scope-test-value-123456", allowedHosts: ["api.example.test"] },
    })
    const key = await s.request("POST", `/api/servers/${id}/keys`, {
      ...admin,
      body: { name: "k" },
    })
    const keyId = (key.json.info as { id: string }).id
    return { id, vid, keyId }
  }
  const a = await mkServer("server-a")
  const b = await mkServer("server-b")

  // An admin of another workspace (multi-tenant readiness: T10).
  const other = createWorkspace(s.database.db, "other")
  const otherUser = createUser(s.database.db, other, {
    email: "other@example.test",
    passwordHash: await hashPassword(PASSWORD),
    role: "admin",
  })
  const otherSession = createSession(s.database.db, other, otherUser.id)
  const outsider: Session = {
    cookie: `__Host-kervan_session=${otherSession.id}`,
    csrf: csrfTokenFor(otherSession.id),
  }
  return { s, admin, member, a, b, outsider }
}

/** Every state-changing route, with a body that would succeed for an admin. */
function stateChanging(a: { id: string; vid: string; keyId: string }) {
  return [
    ["POST", "/api/logout", {}],
    ["POST", "/api/servers", { slug: "new-one", name: "n" }],
    ["DELETE", `/api/servers/${a.id}`, {}],
    ["POST", `/api/servers/${a.id}/versions`, { yaml: SPEC }],
    ["POST", `/api/servers/${a.id}/versions/${a.vid}/validate`, {}],
    ["POST", `/api/servers/${a.id}/versions/${a.vid}/publish`, {}],
    ["POST", `/api/servers/${a.id}/versions/${a.vid}/playground`, {}],
    [
      "PUT",
      `/api/servers/${a.id}/secrets/API_KEY`,
      { value: "sk-attacker-chosen-value-1", allowedHosts: ["evil.test"] },
    ],
    ["DELETE", `/api/servers/${a.id}/secrets/API_KEY`, { confirm: true }],
    ["POST", `/api/servers/${a.id}/keys`, { name: "evil" }],
    ["DELETE", `/api/servers/${a.id}/keys/${a.keyId}`, {}],
    ["PUT", `/api/servers/${a.id}/settings`, { logPayloads: true }],
    ["POST", "/api/users", { email: "evil@example.test", password: PASSWORD, role: "admin" }],
  ] as const
}

describe("every state-changing route refuses cross-origin and token-less requests", () => {
  const variants: [string, Record<string, string | undefined>, boolean, number][] = [
    ["no Origin", { origin: undefined }, true, 403],
    ["another origin", { origin: "https://evil.test" }, true, 403],
    ["Origin null", { origin: "null" }, true, 403],
    ["plain http", { origin: "http://studio.test" }, true, 403],
    ["another port", { origin: "https://studio.test:8443" }, true, 403],
    ["a subdomain", { origin: "https://a.studio.test" }, true, 403],
    ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }, true, 403],
    ["Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site" }, true, 403],
    ["Sec-Fetch-Site none", { "sec-fetch-site": "none" }, true, 403],
    ["a form content type", { "content-type": "application/x-www-form-urlencoded" }, true, 415],
    ["text/plain", { "content-type": "text/plain" }, true, 415],
    ["a JSON look-alike type", { "content-type": "application/jsonp" }, true, 415],
    ["no CSRF token", {}, false, 403],
  ]

  it.each(variants)("%s", async (_label, headers, withCsrf, status) => {
    const { s, admin, a } = await setup()
    const before = listAudit(s.database.db, s.scope, { limit: 1000 }).length
    const session = withCsrf ? admin : { cookie: admin.cookie }
    for (const [method, path, body] of stateChanging(a)) {
      const response = await s.request(method, path, { ...session, body, headers })
      expect(response.status, `${method} ${path}: ${response.text}`).toBe(status)
    }
    // Nothing happened: no audit event, the key still works, the server is still there.
    expect(listAudit(s.database.db, s.scope, { limit: 1000 }).length).toBe(before)
    expect((await s.request("GET", `/api/servers/${a.id}`, admin)).status).toBe(200)
    const keys = await s.request("GET", `/api/servers/${a.id}/keys`, admin)
    expect(keys.json.keys).toEqual([expect.objectContaining({ revokedAt: null })])
  })

  it("refuses another session's CSRF token", async () => {
    const { s, admin, member, a } = await setup()
    for (const [method, path, body] of stateChanging(a)) {
      const response = await s.request(method, path, {
        cookie: admin.cookie,
        csrf: member.csrf,
        body,
      })
      expect(response.status, `${method} ${path}`).toBe(403)
    }
  })

  it("refuses login and setup from another origin", async () => {
    const { s } = await setup()
    for (const path of ["/api/login", "/api/setup"]) {
      const response = await s.request("POST", path, {
        body: { email: "admin@example.test", password: PASSWORD, token: "x" },
        headers: { origin: "https://evil.test" },
      })
      expect(response.status).toBe(403)
      expect(response.headers.get("set-cookie")).toBeNull()
    }
  })

  it("answers a preflight without any CORS header, on the API and the gateway", async () => {
    const { s, a } = await setup()
    for (const path of ["/api/servers", `/s/${a.id}/mcp`]) {
      const response = await s.request("OPTIONS", path, {
        headers: {
          origin: "https://evil.test",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type, x-csrf-token",
        },
      })
      for (const name of response.headers.keys()) {
        expect(name.startsWith("access-control-"), `${path}: ${name}`).toBe(false)
      }
    }
  })
})

describe("admin-only routes refuse members", () => {
  it("refuses every admin-only route and changes nothing", async () => {
    const { s, member, admin, a } = await setup()
    const before = listAudit(s.database.db, s.scope, { limit: 1000 }).length
    const adminOnly = [
      ["GET", "/api/users", undefined],
      ["POST", "/api/users", { email: "m2@example.test", password: PASSWORD, role: "admin" }],
      ["GET", "/api/audit", undefined],
      ["DELETE", `/api/servers/${a.id}`, {}],
      ["PUT", `/api/servers/${a.id}/settings`, { logPayloads: true }],
      ["GET", `/api/servers/${a.id}/secrets`, undefined],
      [
        "PUT",
        `/api/servers/${a.id}/secrets/API_KEY`,
        { value: "sk-member-chosen-value-1", allowedHosts: ["evil.test"] },
      ],
      ["PUT", `/api/servers/${a.id}/secrets/API_KEY`, { allowedHosts: ["evil.test"] }],
      [
        "PUT",
        `/api/servers/${a.id}/secrets/NEW_ONE`,
        { value: "sk-new-12345678", allowedHosts: ["evil.test"] },
      ],
      ["DELETE", `/api/servers/${a.id}/secrets/API_KEY`, { confirm: true }],
      ["GET", `/api/servers/${a.id}/keys`, undefined],
      ["POST", `/api/servers/${a.id}/keys`, { name: "m" }],
      ["DELETE", `/api/servers/${a.id}/keys/${a.keyId}`, {}],
    ] as const
    for (const [method, path, body] of adminOnly) {
      const response = await s.request(method, path, {
        ...member,
        ...(body === undefined ? {} : { body }),
      })
      expect(response.status, `${method} ${path}`).toBe(403)
    }
    expect(listAudit(s.database.db, s.scope, { limit: 1000 }).length).toBe(before)
    const secrets = await s.request("GET", `/api/servers/${a.id}/secrets`, admin)
    expect(secrets.json.secrets).toEqual([
      expect.objectContaining({ name: "API_KEY", allowedHosts: ["api.example.test:443"] }),
    ])
  })

  it("never gives a member logged payloads", async () => {
    const { s, admin, member, a } = await setup()
    await s.request("PUT", `/api/servers/${a.id}/settings`, {
      ...admin,
      body: { logPayloads: true },
    })
    const { recordCall } = await import("../../src/db/repos/call-logs.js")
    recordCall(s.database.db, s.scope, {
      serverId: a.id,
      versionId: a.vid,
      tool: "t",
      status: "ok",
      durationMs: 1,
      args: '{"q":"PAYLOAD-ARGS"}',
      result: '"PAYLOAD-RESULT"',
    })
    const asMember = await s.request("GET", `/api/servers/${a.id}/logs`, member)
    expect(asMember.status).toBe(200)
    expect(asMember.text).not.toContain("PAYLOAD-")
    const asAdmin = await s.request("GET", `/api/servers/${a.id}/logs`, admin)
    expect(asAdmin.text).toContain("PAYLOAD-ARGS")
  })
})

describe("route parameters are scoped to the caller's workspace and the URL's server", () => {
  it("gives another workspace's admin nothing, for every route", async () => {
    const { s, outsider, a, admin } = await setup()
    const before = listAudit(s.database.db, s.scope, { limit: 1000 }).length
    const reads = [
      `/api/servers/${a.id}`,
      `/api/servers/${a.id}/versions/${a.vid}`,
      `/api/servers/${a.id}/versions/${a.vid}/export`,
      `/api/servers/${a.id}/versions/${a.vid}/diff/${a.vid}`,
      `/api/servers/${a.id}/logs`,
      `/api/servers/${a.id}/secrets`,
      `/api/servers/${a.id}/keys`,
    ]
    for (const path of reads) {
      const response = await s.request("GET", path, outsider)
      expect(response.status, path).toBe(404)
    }
    const listed = await s.request("GET", "/api/servers", outsider)
    expect(listed.json.servers).toEqual([])
    for (const [method, path, body] of stateChanging(a)) {
      if (path === "/api/logout" || path === "/api/servers" || path === "/api/users") continue
      const response = await s.request(method, path, { ...outsider, body })
      expect(response.status, `${method} ${path}: ${response.text}`).toBe(404)
    }
    expect(listAudit(s.database.db, s.scope, { limit: 1000 }).length).toBe(before)
    const keys = await s.request("GET", `/api/servers/${a.id}/keys`, admin)
    expect(keys.json.keys).toEqual([expect.objectContaining({ revokedAt: null })])
    const users = await s.request("GET", "/api/users", outsider)
    expect(JSON.stringify(users.json)).not.toContain("admin@example.test")
  })

  it("does not mix one server's versions, keys or secrets into another server's routes", async () => {
    const { s, admin, a, b } = await setup()
    const crossed = [
      ["GET", `/api/servers/${b.id}/versions/${a.vid}`, undefined],
      ["GET", `/api/servers/${b.id}/versions/${a.vid}/export`, undefined],
      ["GET", `/api/servers/${b.id}/versions/${b.vid}/diff/${a.vid}`, undefined],
      ["POST", `/api/servers/${b.id}/versions/${a.vid}/validate`, {}],
      ["POST", `/api/servers/${b.id}/versions/${a.vid}/publish`, {}],
      ["POST", `/api/servers/${b.id}/versions/${a.vid}/playground`, {}],
      ["DELETE", `/api/servers/${b.id}/keys/${a.keyId}`, {}],
    ] as const
    for (const [method, path, body] of crossed) {
      const response = await s.request(method, path, {
        ...admin,
        ...(body === undefined ? {} : { body }),
      })
      expect(response.status, `${method} ${path}`).toBe(404)
    }
    // Server B's secret of the same name is B's own: changing it leaves A's binding alone.
    await s.request("PUT", `/api/servers/${b.id}/secrets/API_KEY`, {
      ...admin,
      body: { allowedHosts: ["evil.test"] },
    })
    const aSecrets = await s.request("GET", `/api/servers/${a.id}/secrets`, admin)
    expect(aSecrets.json.secrets).toEqual([
      expect.objectContaining({ allowedHosts: ["api.example.test:443"] }),
    ])
    const aKeys = await s.request("GET", `/api/servers/${a.id}/keys`, admin)
    expect(aKeys.json.keys).toEqual([expect.objectContaining({ revokedAt: null })])
  })

  it("does not take a playground token or API key as a management credential", async () => {
    const { s, admin, a } = await setup()
    const grant = await s.request("POST", `/api/servers/${a.id}/versions/${a.vid}/playground`, {
      ...admin,
      body: {},
    })
    const token = String(grant.json.token)
    for (const bearer of [token, `kvn_${"A".repeat(43)}`]) {
      const response = await s.request("GET", "/api/servers", {
        headers: { authorization: `Bearer ${bearer}` },
      })
      expect(response.status).toBe(401)
    }
  })
})

it("uses the real public origin in the helpers (sanity)", () => {
  expect(ORIGIN).toBe("https://studio.test")
})
