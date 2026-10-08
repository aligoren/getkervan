// Security review 3, confirmed: session renewal on a password change, and role changes, under
// races. A pause inside the mocked scrypt (../review/hold.ts) makes each race deterministic. After
// every race, no session of the user survives that should not, and no new one appears.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { countSessions } from "../../src/db/repos/sessions.js"
import { type ApiStudio, apiStudio, cookieOf, PASSWORD } from "../api-helpers.js"
import { echoTool, MODERN, spec, startUpstream, type Upstream } from "../helpers.js"
import { arm } from "../review/hold.js"

vi.mock("../../src/crypto.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/crypto.js")>()
  const { maybeHold } = await import("../review/hold.js")
  return {
    ...original,
    hashPassword: async (password: string) => {
      const result = await original.hashPassword(password)
      await maybeHold("hash", password)
      return result
    },
    verifyPassword: async (password: string, stored: string) => {
      const result = await original.verifyPassword(password, stored)
      await maybeHold("verify", password)
      return result
    },
  }
})

const NEW_PASSWORD = "a brand new password 42"
const ADMIN_PASSWORD_CHANGE = "the admins own new password 7"

let upstream: Upstream
beforeAll(async () => {
  upstream = await startUpstream()
})
afterAll(() => upstream.close())

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

async function setup() {
  const s = apiStudio()
  studios.push(s)
  await s.addUser("admin@example.test", "admin")
  await s.addUser("admin2@example.test", "admin")
  const member = await s.addUser("member@example.test", "member")
  const admin = await s.signIn("admin@example.test")
  const memberSession = await s.signIn("member@example.test")
  const changePassword = (who: { cookie: string; csrf: string }) =>
    s.request("PUT", "/api/profile/password", {
      ...who,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    })
  return { s, admin, member, memberSession, changePassword }
}

describe("a password change in flight (held after hashing the new password)", () => {
  it("loses to a role change of the same user: 409, and no session of the user is left", async () => {
    const { s, admin, member, memberSession, changePassword } = await setup()
    const held = arm("hash", NEW_PASSWORD)
    const change = changePassword(memberSession)
    await held.reached
    const role = await s.request("PUT", `/api/users/${member.id}/role`, {
      ...admin,
      body: { role: "admin", adminPassword: PASSWORD },
    })
    expect(role.status).toBe(200)
    held.release()
    const result = await change
    expect(result.status).toBe(409)
    expect(result.headers.get("set-cookie")).toBeNull()
    expect(countSessions(s.database.db, s.scope, member.id)).toBe(0)
    expect((await s.request("GET", "/api/me", memberSession)).status).toBe(401)
    // The password did not change either.
    await expect(s.signIn("member@example.test", NEW_PASSWORD)).rejects.toThrow(/401/)
  })

  it("loses to a deactivation of the user", async () => {
    const { s, admin, member, memberSession, changePassword } = await setup()
    const held = arm("hash", NEW_PASSWORD)
    const change = changePassword(memberSession)
    await held.reached
    const off = await s.request("PUT", `/api/users/${member.id}`, {
      ...admin,
      body: { disabled: true },
    })
    expect(off.status).toBe(200)
    held.release()
    const result = await change
    expect(result.status).toBe(409)
    expect(result.headers.get("set-cookie")).toBeNull()
    expect(countSessions(s.database.db, s.scope, member.id)).toBe(0)
  })

  it("loses to a sign-out of the same session", async () => {
    const { s, member, memberSession, changePassword } = await setup()
    const held = arm("hash", NEW_PASSWORD)
    const change = changePassword(memberSession)
    await held.reached
    expect((await s.request("POST", "/api/logout", { ...memberSession, body: {} })).status).toBe(
      200,
    )
    held.release()
    const result = await change
    expect(result.status).toBe(409)
    expect(result.headers.get("set-cookie")).toBeNull()
    expect(countSessions(s.database.db, s.scope, member.id)).toBe(0)
  })

  it("loses to a concurrent change from another session; only the winner's renewed session is left", async () => {
    const { s, member, memberSession, changePassword } = await setup()
    const second = await s.signIn("member@example.test")
    const held = arm("hash", NEW_PASSWORD)
    const first = changePassword(memberSession)
    await held.reached
    const winner = await s.request("PUT", "/api/profile/password", {
      ...second,
      body: { currentPassword: PASSWORD, newPassword: "the second new password 9" },
    })
    expect(winner.status).toBe(200)
    held.release()
    const loser = await first
    expect(loser.status).toBe(409)
    expect(loser.headers.get("set-cookie")).toBeNull()
    expect(countSessions(s.database.db, s.scope, member.id)).toBe(1)
    const renewed = cookieOf(winner.headers)
    expect((await s.request("GET", "/api/me", { cookie: renewed })).status).toBe(200)
    expect((await s.request("GET", "/api/me", second)).status).toBe(401)
    expect((await s.request("GET", "/api/me", memberSession)).status).toBe(401)
  })

  it("loses to an admin's reset; the user is left with no session", async () => {
    const { s, admin, member, memberSession, changePassword } = await setup()
    const held = arm("hash", NEW_PASSWORD)
    const change = changePassword(memberSession)
    await held.reached
    const reset = await s.request("POST", `/api/users/${member.id}/password-reset`, {
      ...admin,
      body: { adminPassword: PASSWORD },
    })
    expect(reset.status).toBe(200)
    held.release()
    expect((await change).status).toBe(409)
    expect(countSessions(s.database.db, s.scope, member.id)).toBe(0)
  })
})

describe("a renewed session", () => {
  it("leaves the old session's playground token dead at the gateway", async () => {
    const { s, admin } = await setup()
    const created = await s.request("POST", "/api/servers", {
      ...admin,
      body: { slug: "srv", name: "srv" },
    })
    const serverId = (created.json.server as { id: string }).id
    const saved = await s.request("POST", `/api/servers/${serverId}/versions`, {
      ...admin,
      body: { yaml: spec(echoTool(`${upstream.url}/echo/r3`)) },
    })
    const versionId = (saved.json.version as { id: string }).id
    const grant = await s.request(
      "POST",
      `/api/servers/${serverId}/versions/${versionId}/playground`,
      { ...admin, body: {} },
    )
    const token = String(grant.json.token)
    const list = () =>
      s.request("POST", `/s/${serverId}/mcp`, {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MODERN,
          "mcp-method": "tools/list",
        },
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": MODERN,
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        },
      })
    expect((await list()).status).toBe(200)
    const changed = await s.request("PUT", "/api/profile/password", {
      ...admin,
      body: { currentPassword: PASSWORD, newPassword: ADMIN_PASSWORD_CHANGE },
    })
    expect(changed.status).toBe(200)
    expect((await list()).status).toBe(401)
  })
})

describe("a sign-in in flight across a role change", () => {
  it("gets a session that carries the new role, never the old one", async () => {
    const { s, admin, member } = await setup()
    const held = arm("verify", PASSWORD)
    const login = s.request("POST", "/api/login", {
      body: { email: "member@example.test", password: PASSWORD },
      ip: "198.51.100.7",
    })
    await held.reached
    const role = await s.request("PUT", `/api/users/${member.id}/role`, {
      ...admin,
      body: { role: "admin", adminPassword: PASSWORD },
    })
    expect(role.status).toBe(200)
    held.release()
    const done = await login
    if (done.status === 200) {
      expect((done.json.user as { role: string }).role).toBe("admin")
      const me = await s.request("GET", "/api/me", { cookie: cookieOf(done.headers) })
      expect((me.json.user as { role: string }).role).toBe("admin")
    }
    // And a demotion: the member's next sign-in is a member's, every earlier session is gone.
    const demote = await s.request("PUT", `/api/users/${member.id}/role`, {
      ...admin,
      body: { role: "member", adminPassword: PASSWORD },
    })
    expect(demote.status).toBe(200)
    expect(countSessions(s.database.db, s.scope, member.id)).toBe(0)
  })
})
