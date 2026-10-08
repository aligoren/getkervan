// A request is authorized when it comes in, then waits (for its body, a spec load, a password
// hash) before it writes. Every write checks again, in its transaction, that the user is still
// active and, for admin actions, still an admin (`requireActor`). Here the user is demoted or
// deactivated while the request waits; the write is refused and nothing changes.
import { HonoRequest } from "hono/request"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { listApiKeys } from "../src/db/repos/api-keys.js"
import { getServer, listServers } from "../src/db/repos/servers.js"
import { setDisabledAt, updateUser } from "../src/db/repos/users.js"
import { listVersions } from "../src/db/repos/versions.js"
import { StudioError } from "../src/studio.js"
import { type ApiStudio, apiStudio } from "./api-helpers.js"
import { echoTool, spec, startUpstream, type Upstream } from "./helpers.js"

let upstream: Upstream
beforeAll(async () => {
  upstream = await startUpstream()
})
afterAll(() => upstream.close())

const studios: ApiStudio[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const s of studios.splice(0)) await s.close()
})

async function setup() {
  const s = apiStudio()
  studios.push(s)
  const adminUser = await s.addUser("admin@example.test", "admin")
  const memberUser = await s.addUser("member@example.test", "member")
  const admin = await s.signIn("admin@example.test")
  const member = await s.signIn("member@example.test", undefined, "203.0.113.7")
  const created = await s.request("POST", "/api/servers", {
    ...admin,
    body: { slug: "srv", name: "Server" },
  })
  const serverId = (created.json.server as { id: string }).id
  const saved = await s.request("POST", `/api/servers/${serverId}/versions`, {
    ...admin,
    body: { yaml: spec(echoTool(`${upstream.url}/echo/a`)) },
  })
  const versionId = (saved.json.version as { id: string }).id
  return { s, adminUser, memberUser, admin, member, serverId, versionId }
}

/**
 * Sends a request that waits, until `release` is called, where its handler reads the body: after
 * the API checked the session, the CSRF token and the role, before anything is written. `reached`
 * resolves once it waits there.
 */
function held(
  s: ApiStudio,
  method: string,
  path: string,
  who: { cookie: string; csrf: string },
  body: unknown,
) {
  let release!: () => void
  let reached!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    reached = resolve
  })
  const original = HonoRequest.prototype.json
  const spy = vi.spyOn(HonoRequest.prototype, "json").mockImplementation(async function (
    this: HonoRequest,
  ) {
    spy.mockRestore()
    reached()
    await gate
    return original.call(this)
  })
  const response = s.request(method, path, { ...who, body })
  return { response, release, reached: waiting }
}

describe("an admin demoted while the request waits", () => {
  const cases: {
    name: string
    request: (t: Awaited<ReturnType<typeof setup>>) => [string, string, unknown]
    unchanged: (t: Awaited<ReturnType<typeof setup>>) => void | Promise<void>
  }[] = [
    {
      name: "setting a secret",
      request: ({ serverId }) => [
        "PUT",
        `/api/servers/${serverId}/secrets/API_KEY`,
        { value: "a-long-enough-value", allowedHosts: ["api.example.com"] },
      ],
      unchanged: async ({ s, serverId }) =>
        expect(await s.studio.listSecrets(s.scope, serverId)).toEqual([]),
    },
    {
      name: "creating an API key",
      request: ({ serverId }) => ["POST", `/api/servers/${serverId}/keys`, { name: "k" }],
      unchanged: ({ s, serverId }) =>
        expect(listApiKeys(s.database.db, s.scope, serverId)).toEqual([]),
    },
    {
      name: "turning on payload logging",
      request: ({ serverId }) => [
        "PUT",
        `/api/servers/${serverId}/settings`,
        { logPayloads: true },
      ],
      unchanged: ({ s, serverId }) =>
        expect(getServer(s.database.db, s.scope, serverId)?.logPayloads).toBe(false),
    },
  ]
  for (const each of cases) {
    it(`is refused: ${each.name}`, async () => {
      const t = await setup()
      const [method, path, body] = each.request(t)
      const { response, release, reached } = held(t.s, method, path, t.admin, body)
      await reached
      // Demoted meanwhile (written directly: the session stays, so only the write's check is left).
      updateUser(t.s.database.db, t.s.scope, t.adminUser.id, { role: "member" })
      release()
      const result = await response
      expect(result.status).toBe(403)
      expect(result.json).toEqual({ error: "Only admins can do this." })
      await each.unchanged(t)
    })
  }

  it("is refused: deleting a secret, demoted while its usage is checked", async () => {
    const t = await setup()
    await t.s.request("PUT", `/api/servers/${t.serverId}/secrets/API_KEY`, {
      ...t.admin,
      body: { value: "a-long-enough-value", allowedHosts: ["api.example.com"] },
    })
    // The usage check loads the published spec; it waits here until released.
    let release!: () => void
    let reached!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      reached = resolve
    })
    const original = t.s.studio.secretUsage.bind(t.s.studio)
    vi.spyOn(t.s.studio, "secretUsage").mockImplementation(async (...args) => {
      reached()
      await gate
      return original(...args)
    })
    const response = t.s.request("DELETE", `/api/servers/${t.serverId}/secrets/API_KEY`, {
      ...t.admin,
      body: { confirm: true },
    })
    await waiting
    updateUser(t.s.database.db, t.s.scope, t.adminUser.id, { role: "member" })
    release()
    expect((await response).status).toBe(403)
    expect((await t.s.studio.listSecrets(t.s.scope, t.serverId)).map((x) => x.name)).toEqual([
      "API_KEY",
    ])
  })
})

describe("a member deactivated while the request waits", () => {
  const cases: {
    name: string
    request: (t: Awaited<ReturnType<typeof setup>>) => [string, string, unknown]
    unchanged: (t: Awaited<ReturnType<typeof setup>>) => void
  }[] = [
    {
      name: "creating a server",
      request: () => ["POST", "/api/servers", { slug: "new-one", name: "New" }],
      unchanged: ({ s }) => expect(listServers(s.database.db, s.scope)).toHaveLength(1),
    },
    {
      name: "saving a version",
      request: ({ serverId }) => [
        "POST",
        `/api/servers/${serverId}/versions`,
        { yaml: spec(echoTool(`${upstream.url}/echo/b`)) },
      ],
      unchanged: ({ s, serverId }) =>
        expect(listVersions(s.database.db, s.scope, serverId)).toHaveLength(1),
    },
  ]
  for (const each of cases) {
    it(`is refused: ${each.name}`, async () => {
      const t = await setup()
      const [method, path, body] = each.request(t)
      const { response, release, reached } = held(t.s, method, path, t.member, body)
      await reached
      setDisabledAt(t.s.database.db, t.s.scope, t.memberUser.id, Date.now())
      release()
      const result = await response
      expect(result.status).toBe(403)
      expect(result.json).toEqual({
        error: "Your account is no longer active. Sign in again.",
      })
      each.unchanged(t)
    })
  }

  it("is refused: publishing, deactivated while the version is validated", async () => {
    const t = await setup()
    let release!: () => void
    let reached!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const waiting = new Promise<void>((resolve) => {
      reached = resolve
    })
    const original = t.s.studio.validate.bind(t.s.studio)
    vi.spyOn(t.s.studio, "validate").mockImplementation(async (...args) => {
      const issues = await original(...args)
      reached()
      await gate
      return issues
    })
    const response = t.s.request(
      "POST",
      `/api/servers/${t.serverId}/versions/${t.versionId}/publish`,
      { ...t.member, body: {} },
    )
    await waiting
    setDisabledAt(t.s.database.db, t.s.scope, t.memberUser.id, Date.now())
    release()
    expect((await response).status).toBe(403)
    expect(getServer(t.s.database.db, t.s.scope, t.serverId)?.publishedVersionId).toBeNull()
  })

  it("is refused: changing their own display name or theme", async () => {
    const t = await setup()
    for (const [path, body] of [
      ["/api/profile", { displayName: "Changed" }],
      ["/api/profile/theme", { theme: "dark" }],
    ] as const) {
      const { response, release, reached } = held(t.s, "PUT", path, t.member, body)
      await reached
      setDisabledAt(t.s.database.db, t.s.scope, t.memberUser.id, Date.now())
      release()
      expect((await response).status, path).toBe(403)
      setDisabledAt(t.s.database.db, t.s.scope, t.memberUser.id, null)
    }
  })
})

describe("every write of Studio checks the actor it was authorized for", () => {
  it("refuses an admin action for a member, and any action for a deactivated user", async () => {
    const t = await setup()
    const { s, serverId, versionId, memberUser } = t
    const asAdmin = { type: "user" as const, id: memberUser.id, requires: "admin" as const }
    const asUser = { type: "user" as const, id: memberUser.id, requires: "user" as const }
    const keyId = s.studio.createApiKey(s.scope, serverId, "k", { type: "user", id: "x" }).info.id
    const refused = async (what: string, run: () => unknown) => {
      const error = await Promise.resolve()
        .then(run)
        .then(
          () => undefined,
          (e: unknown) => e,
        )
      expect(error, what).toBeInstanceOf(StudioError)
      expect((error as StudioError).code, what).toBe("forbidden")
    }
    await refused("deleteServer", () => s.studio.deleteServer(s.scope, serverId, asAdmin))
    await refused("createApiKey", () => s.studio.createApiKey(s.scope, serverId, "k2", asAdmin))
    await refused("revokeApiKey", () => s.studio.revokeApiKey(s.scope, keyId, asAdmin))
    await refused("setLogPayloads", () => s.studio.setLogPayloads(s.scope, serverId, true, asAdmin))
    await refused("putSecret", () =>
      s.studio.putSecret(
        s.scope,
        serverId,
        { name: "API_KEY", value: "a-long-enough-value", allowedHosts: ["api.example.com"] },
        asAdmin,
      ),
    )
    await refused("deleteSecret", () =>
      s.studio.deleteSecret(s.scope, serverId, "API_KEY", { confirm: true }, asAdmin),
    )
    setDisabledAt(s.database.db, s.scope, memberUser.id, Date.now())
    await refused("createServer", () =>
      s.studio.createServer(s.scope, { slug: "x", name: "X" }, asUser),
    )
    await refused("saveVersion", () => s.studio.saveVersion(s.scope, serverId, "x: 1", asUser))
    await refused("publish", () => s.studio.publish(s.scope, serverId, versionId, asUser))
    await refused("setServerDisabled", () =>
      s.studio.setServerDisabled(s.scope, serverId, true, asUser),
    )
    // Nothing changed.
    expect(getServer(s.database.db, s.scope, serverId)).toMatchObject({
      logPayloads: false,
      disabledAt: null,
      publishedVersionId: null,
    })
    expect(listApiKeys(s.database.db, s.scope, serverId).map((k) => k.revokedAt)).toEqual([null])
  })
})
