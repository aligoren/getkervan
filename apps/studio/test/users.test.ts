import { afterEach, describe, expect, it } from "vitest"
import { verifyLogin } from "../src/accounts.js"
import { listAudit } from "../src/db/repos/audit.js"
import { countSessions, findSession } from "../src/db/repos/sessions.js"
import { createUser, setDisabledAt } from "../src/db/repos/users.js"
import { createWorkspace } from "../src/db/repos/workspaces.js"
import { type ApiStudio, apiStudio, PASSWORD } from "./api-helpers.js"
import { echoTool, MODERN, spec } from "./helpers.js"

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

async function setup() {
  const s = apiStudio()
  studios.push(s)
  const owner = await s.addUser("admin@example.test", "admin")
  const admin = await s.signIn("admin@example.test")
  const member = await s.addUser("member@example.test", "member")
  const setDisabled = (userId: string, disabled: boolean, as = admin) =>
    s.request("PUT", `/api/users/${userId}`, { ...as, body: { disabled } })
  return { s, owner, admin, member, setDisabled }
}

/** A raw tools/list through the gateway with a bearer token. */
function toolsList(s: ApiStudio, serverId: string, bearer: string) {
  return s.request("POST", `/s/${serverId}/mcp`, {
    headers: {
      authorization: `Bearer ${bearer}`,
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
}

describe("deactivating a user", () => {
  it("ends their sessions and playground tokens at once, and refuses their sign-in", async () => {
    const { s, admin, member, setDisabled } = await setup()
    const session = await s.signIn("member@example.test")
    const created = await s.request("POST", "/api/servers", {
      ...session,
      body: { slug: "tools", name: "Tools" },
    })
    const serverId = String((created.json.server as { id: string }).id)
    const saved = await s.request("POST", `/api/servers/${serverId}/versions`, {
      ...session,
      body: { yaml: spec(echoTool("https://api.example.com/x")) },
    })
    const versionId = String((saved.json.version as { id: string }).id)
    const grant = await s.request(
      "POST",
      `/api/servers/${serverId}/versions/${versionId}/playground`,
      { ...session, body: {} },
    )
    const token = String(grant.json.token)
    expect((await toolsList(s, serverId, token)).status).toBe(200)

    const response = await setDisabled(member.id, true)
    expect(response.status, response.text).toBe(200)
    expect(response.json.user).toMatchObject({ id: member.id, disabledAt: expect.any(Number) })

    // Sessions are gone from the database, not only refused.
    expect(countSessions(s.database.db, s.scope, member.id)).toBe(0)
    expect((await s.request("GET", "/api/me", { cookie: session.cookie })).status).toBe(401)
    expect((await toolsList(s, serverId, token)).status).toBe(401)

    // The right password gets the same answer as a wrong one.
    const right = await s.request("POST", "/api/login", {
      body: { email: "member@example.test", password: PASSWORD },
    })
    const wrong = await s.request("POST", "/api/login", {
      body: { email: "member@example.test", password: "not the password!" },
    })
    expect([right.status, wrong.status]).toEqual([401, 401])
    expect(right.text).toBe(wrong.text)

    // Listed as deactivated; recorded with the number of sessions it ended.
    const users = (await s.request("GET", "/api/users", admin)).json.users as {
      id: string
      disabledAt: number | null
    }[]
    expect(users.find((u) => u.id === member.id)?.disabledAt).toEqual(expect.any(Number))
    const event = listAudit(s.database.db, s.scope, { action: "user.disable" })[0]
    expect(event).toMatchObject({ targetId: member.id })
    expect(event?.details).toEqual({ sessionsEnded: 1 })
  })

  it("can be undone: the user signs in again, and that is recorded", async () => {
    const { s, member, setDisabled } = await setup()
    await setDisabled(member.id, true)
    const back = await setDisabled(member.id, false)
    expect(back.status).toBe(200)
    expect(back.json.user).toMatchObject({ disabledAt: null })
    await expect(s.signIn("member@example.test")).resolves.toMatchObject({ cookie: /=/ })
    expect(listAudit(s.database.db, s.scope, { action: "user.enable" })).toHaveLength(1)
  })

  it("never deactivates the last active admin, including oneself", async () => {
    const { s, owner, admin, setDisabled } = await setup()
    const alone = await setDisabled(owner.id, true)
    expect(alone.status).toBe(409)
    expect(alone.json.error).toMatch(/last active admin/)
    expect((await s.request("GET", "/api/me", { cookie: admin.cookie })).status).toBe(200)

    // With a second admin, one of them can go; then the other is the last again.
    const second = await s.addUser("second@example.test", "admin")
    expect((await setDisabled(second.id, true)).status).toBe(200)
    expect((await setDisabled(owner.id, true)).status).toBe(409)
    expect(listAudit(s.database.db, s.scope, { action: "user.disable" })).toHaveLength(1)
  })

  it("is for admins only, and only for users of their workspace", async () => {
    const { s, owner, member, setDisabled } = await setup()
    const asMember = await s.signIn("member@example.test")
    expect((await setDisabled(owner.id, true, asMember)).status).toBe(403)
    const other = createWorkspace(s.database.db, "other")
    const stranger = createUser(s.database.db, other, {
      email: "stranger@example.test",
      passwordHash: "unused",
      role: "member",
    })
    expect((await setDisabled(stranger.id, true)).status).toBe(404)
    expect((await setDisabled("no-such-user", true)).status).toBe(404)
    expect((await setDisabled(member.id, "yes" as unknown as boolean)).status).toBe(400)
  })
})

describe("a deactivated user, checked where credentials are used", () => {
  // Deactivation deletes sessions; these checks hold even for a session that was left behind.
  it("has no live session, even one that was not deleted", async () => {
    const { s, member } = await setup()
    const session = await s.signIn("member@example.test")
    const id = session.cookie.split("=")[1] ?? ""
    expect(findSession(s.database.db, id)).toBeDefined()
    setDisabledAt(s.database.db, s.scope, member.id, Date.now())
    expect(findSession(s.database.db, id)).toBeUndefined()
  })

  it("cannot sign in", async () => {
    const { s, member } = await setup()
    expect(
      await verifyLogin(s.database.db, s.scope, "member@example.test", PASSWORD),
    ).toMatchObject({ id: member.id })
    setDisabledAt(s.database.db, s.scope, member.id, Date.now())
    expect(
      await verifyLogin(s.database.db, s.scope, "member@example.test", PASSWORD),
    ).toBeUndefined()
  })
})
