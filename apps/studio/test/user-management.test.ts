// User management: profile, own password, admin edits (role, email, reset), forced password
// change, and the rules that protect them. Each describe block is one rule.
import { afterEach, describe, expect, it } from "vitest"
import { setTheme } from "../src/accounts.js"
import { listAudit } from "../src/db/repos/audit.js"
import { countActiveAdmins, createUser, getUser } from "../src/db/repos/users.js"
import { createWorkspace } from "../src/db/repos/workspaces.js"
import { type ApiStudio, apiStudio, cookieOf, ORIGIN, PASSWORD } from "./api-helpers.js"
import { echoTool, MODERN, spec } from "./helpers.js"

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

const NEW_PASSWORD = "a brand new passphrase 42"

async function setup(options: Parameters<typeof apiStudio>[0] = {}) {
  const s = apiStudio(options)
  studios.push(s)
  const owner = await s.addUser("admin@example.test", "admin")
  const admin = await s.signIn("admin@example.test")
  const memberUser = await s.addUser("member@example.test", "member")
  const member = await s.signIn("member@example.test")
  type As = typeof admin
  const put = (as: As, path: string, body: unknown) =>
    s.request("PUT", `/api${path}`, { ...as, body })
  const post = (as: As, path: string, body: unknown = {}) =>
    s.request("POST", `/api${path}`, { ...as, body })
  return { s, owner, admin, memberUser, member, put, post }
}

const ACTOR = { type: "user" as const, id: "test-actor" }

/** Every audit row and every response body must be free of these. */
function expectNoPasswords(text: string, ...passwords: string[]) {
  for (const password of [PASSWORD, NEW_PASSWORD, ...passwords]) {
    expect(text, "a password leaked").not.toContain(password)
  }
}

describe("rule: the last active admin stays an active admin", () => {
  it("cannot deactivate or demote themselves when they are the only admin", async () => {
    const { s, owner, admin, put } = await setup()
    const deactivate = await put(admin, `/users/${owner.id}`, { disabled: true })
    const demote = await put(admin, `/users/${owner.id}/role`, {
      role: "member",
      adminPassword: PASSWORD,
    })
    expect([deactivate.status, demote.status]).toEqual([409, 409])
    expect(demote.json.error).toBe("The last active admin cannot stop being an admin.")
    expect(getUser(s.database.db, s.scope, owner.id)).toMatchObject({
      role: "admin",
      disabledAt: null,
    })
  })

  it("counts only active admins: a deactivated admin does not keep the last one replaceable", async () => {
    const { s, owner, admin, put } = await setup()
    const second = await s.addUser("second@example.test", "admin")
    expect((await put(admin, `/users/${second.id}`, { disabled: true })).status).toBe(200)
    expect(
      (await put(admin, `/users/${owner.id}/role`, { role: "member", adminPassword: PASSWORD }))
        .status,
    ).toBe(409)
    // Once the second is back, either may become a member.
    expect((await put(admin, `/users/${second.id}`, { disabled: false })).status).toBe(200)
    expect(
      (await put(admin, `/users/${second.id}/role`, { role: "member", adminPassword: PASSWORD }))
        .status,
    ).toBe(200)
    expect(
      (await put(admin, `/users/${owner.id}/role`, { role: "member", adminPassword: PASSWORD }))
        .status,
    ).toBe(409)
  })

  it("holds when two requests race to remove the two admins", async () => {
    const { s, owner, admin, put } = await setup()
    const second = await s.addUser("second@example.test", "admin")
    const results = await Promise.all([
      put(admin, `/users/${owner.id}`, { disabled: true }),
      put(admin, `/users/${second.id}`, { disabled: true }),
    ])
    // The admin deactivated themselves first, so their second request is no longer an admin's
    // (403); in either order, one active admin is left.
    expect(results.map((r) => r.status).sort()).toEqual([200, 403])
    expect(countActiveAdmins(s.database.db, s.scope)).toBe(1)

    // Demoting one while deactivating the other, at once.
    const t = await setup()
    const third = await t.s.addUser("third@example.test", "admin")
    const raced = await Promise.all([
      t.put(t.admin, `/users/${t.owner.id}/role`, { role: "member", adminPassword: PASSWORD }),
      t.put(t.admin, `/users/${third.id}`, { disabled: true }),
    ])
    expect(raced.map((r) => r.status).sort()).toEqual([200, 409])
    expect(countActiveAdmins(t.s.database.db, t.s.scope)).toBe(1)
  })

  it("cannot be deleted: there is no way to delete a user", async () => {
    const { s, owner, admin } = await setup()
    const response = await s.request("DELETE", `/api/users/${owner.id}`, { ...admin, body: {} })
    expect(response.status).toBe(404)
    expect(getUser(s.database.db, s.scope, owner.id)).toBeDefined()
  })
})

describe("rule: a role change needs the admin's own password, checked by the server", () => {
  it("refuses a role change without the password, or with a wrong one", async () => {
    const { s, memberUser, admin, put } = await setup()
    const missing = await put(admin, `/users/${memberUser.id}/role`, { role: "admin" })
    const wrong = await put(admin, `/users/${memberUser.id}/role`, {
      role: "admin",
      adminPassword: "not my password",
    })
    expect([missing.status, wrong.status]).toEqual([400, 403])
    expect(wrong.json.error).toBe("Your password is wrong.")
    expect(getUser(s.database.db, s.scope, memberUser.id)?.role).toBe("member")
    const right = await put(admin, `/users/${memberUser.id}/role`, {
      role: "admin",
      adminPassword: PASSWORD,
    })
    expect(right.status).toBe(200)
    expect(getUser(s.database.db, s.scope, memberUser.id)?.role).toBe("admin")
  })

  it("locks after too many wrong passwords, like a sign-in", async () => {
    const { memberUser, admin, put } = await setup({
      throttle: { accountFailures: 3, ipFailures: 1000 },
    })
    const promote = (adminPassword: string) =>
      put(admin, `/users/${memberUser.id}/role`, { role: "admin", adminPassword })
    for (let i = 0; i < 3; i++) expect((await promote(`wrong pw ${i}`)).status).toBe(403)
    expect((await promote(PASSWORD)).status).toBe(429)
  })
})

describe("rule: a member edits only their own profile", () => {
  it("gets 403 from every admin endpoint about another user (IDOR)", async () => {
    const { s, owner, member, put, post } = await setup()
    const attempts = [
      await s.request("GET", "/api/users", member),
      await s.request("GET", `/api/users/${owner.id}/keys`, member),
      await put(member, `/users/${owner.id}`, { disabled: true }),
      await put(member, `/users/${owner.id}/role`, { role: "member", adminPassword: PASSWORD }),
      await put(member, `/users/${owner.id}/email`, { email: "mine@example.test" }),
      await post(member, `/users/${owner.id}/password-reset`, { adminPassword: PASSWORD }),
    ]
    expect(attempts.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403])
    expect(getUser(s.database.db, s.scope, owner.id)).toMatchObject({
      email: "admin@example.test",
      role: "admin",
      disabledAt: null,
    })
  })

  it("cannot raise their own role or change their email through the profile (mass assignment)", async () => {
    const { s, memberUser, member, put } = await setup()
    const withRole = await put(member, "/profile", { displayName: "M", role: "admin" })
    const withEmail = await put(member, "/profile", { displayName: "M", email: "x@example.test" })
    const withId = await put(member, "/profile", { displayName: "M", id: "someone-else" })
    expect([withRole.status, withEmail.status, withId.status]).toEqual([400, 400, 400])
    expect(getUser(s.database.db, s.scope, memberUser.id)).toMatchObject({
      role: "member",
      email: "member@example.test",
      displayName: null,
    })
    // Their own role through the admin endpoint: 403, as above.
    expect(
      (
        await put(member, `/users/${memberUser.id}/role`, {
          role: "admin",
          adminPassword: PASSWORD,
        })
      ).status,
    ).toBe(403)
  })

  it("changes only their own display name (the profile has no user id to point elsewhere)", async () => {
    const { s, owner, memberUser, member, put } = await setup()
    const saved = await put(member, "/profile", { displayName: "  Mehmet  " })
    expect(saved.status).toBe(200)
    expect(getUser(s.database.db, s.scope, memberUser.id)?.displayName).toBe("Mehmet")
    expect(getUser(s.database.db, s.scope, owner.id)?.displayName).toBeNull()
  })

  it("cannot end another user's session by its reference", async () => {
    const { s, admin, member } = await setup()
    const adminSessions = await s.request("GET", "/api/profile/sessions", admin)
    const ref = (adminSessions.json.sessions as { ref: string }[])[0]?.ref ?? ""
    const response = await s.request("DELETE", `/api/profile/sessions/${ref}`, {
      ...member,
      body: {},
    })
    expect(response.status).toBe(404)
    expect((await s.request("GET", "/api/me", admin)).status).toBe(200)
  })

  it("cannot reach another workspace's users as an admin", async () => {
    const { s, admin, put, post } = await setup()
    const other = createWorkspace(s.database.db, "other")
    const stranger = createUser(s.database.db, other, {
      email: "stranger@example.test",
      passwordHash: "unused",
      role: "admin",
    })
    const attempts = [
      await put(admin, `/users/${stranger.id}/role`, { role: "member", adminPassword: PASSWORD }),
      await put(admin, `/users/${stranger.id}/email`, { email: "taken@example.test" }),
      await post(admin, `/users/${stranger.id}/password-reset`, { adminPassword: PASSWORD }),
    ]
    expect(attempts.map((r) => r.status)).toEqual([404, 404, 404])
    expect(getUser(s.database.db, other, stranger.id)).toMatchObject({
      role: "admin",
      email: "stranger@example.test",
      mustChangePassword: false,
    })
  })
})

describe("rule: emails are unique, case-insensitively, and the sign-in page still tells nothing", () => {
  it("refuses another user's email in any case, with a clear message for the admin", async () => {
    const { s, admin, memberUser, put } = await setup()
    const clash = await put(admin, `/users/${memberUser.id}/email`, {
      email: "  ADMIN@Example.TEST ",
    })
    expect(clash.status).toBe(409)
    expect(clash.json.error).toBe("Another user already has this email.")
    expect(getUser(s.database.db, s.scope, memberUser.id)?.email).toBe("member@example.test")
  })

  it("normalizes a new email; the member signs in with it, not the old one", async () => {
    const { s, admin, memberUser, put } = await setup()
    const changed = await put(admin, `/users/${memberUser.id}/email`, {
      email: "New.Member@Example.test",
    })
    expect(changed.status).toBe(200)
    expect((changed.json.user as { email: string }).email).toBe("new.member@example.test")
    await expect(s.signIn("new.member@example.test")).resolves.toBeDefined()
    await expect(s.signIn("member@example.test")).rejects.toThrow(/401/)
  })

  it("gives the same sign-in answer for a taken email and an unknown one", async () => {
    const { s } = await setup()
    const known = await s.request("POST", "/api/login", {
      body: { email: "member@example.test", password: "wrong password here" },
    })
    const unknown = await s.request("POST", "/api/login", {
      body: { email: "nobody@example.test", password: "wrong password here" },
    })
    expect([known.status, unknown.status]).toEqual([401, 401])
    expect(known.text).toBe(unknown.text)
  })
})

describe("rule: password changes and resets are throttled like sign-ins", () => {
  it("locks the account after too many wrong current passwords, even for the right one", async () => {
    const { s, member, put } = await setup({ throttle: { accountFailures: 3, ipFailures: 1000 } })
    for (let i = 0; i < 3; i++) {
      const wrong = await put(member, "/profile/password", {
        currentPassword: `wrong password ${i}!`,
        newPassword: NEW_PASSWORD,
      })
      expect(wrong.status).toBe(403)
    }
    const right = await put(member, "/profile/password", {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    })
    expect(right.status).toBe(429)
    // The same lock as sign-in: the account cannot sign in either.
    const login = await s.request("POST", "/api/login", {
      body: { email: "member@example.test", password: PASSWORD },
      ip: "198.51.100.9",
    })
    expect(login.status).toBe(429)
  })

  it("asks the admin's own password for a reset, and locks after too many wrong ones", async () => {
    const { memberUser, admin, post } = await setup({
      throttle: { accountFailures: 3, ipFailures: 1000 },
    })
    const reset = (adminPassword: string) =>
      post(admin, `/users/${memberUser.id}/password-reset`, { adminPassword })
    for (let i = 0; i < 3; i++) expect((await reset(`wrong admin pw ${i}`)).status).toBe(403)
    expect((await reset(PASSWORD)).status).toBe(429)
  })
})

describe("rule: every change needs the session's CSRF token and Studio's origin, and is audited", () => {
  const changes = (memberId: string) =>
    [
      ["PUT", "/api/profile", { displayName: "x" }],
      ["PUT", "/api/profile/password", { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }],
      ["POST", "/api/profile/sessions/end-others", {}],
      ["PUT", `/api/users/${memberId}/role`, { role: "admin", adminPassword: PASSWORD }],
      ["PUT", `/api/users/${memberId}/email`, { email: "x@example.test" }],
      ["POST", `/api/users/${memberId}/password-reset`, { adminPassword: PASSWORD }],
    ] as const

  it("refuses them without the CSRF token, or from another origin", async () => {
    const { s, admin, memberUser } = await setup()
    for (const [method, path, body] of changes(memberUser.id)) {
      const noToken = await s.request(method, path, { cookie: admin.cookie, body })
      const foreign = await s.request(method, path, {
        ...admin,
        body,
        headers: { origin: "https://evil.test" },
      })
      expect([noToken.status, foreign.status], path).toEqual([403, 403])
    }
    expect(getUser(s.database.db, s.scope, memberUser.id)).toMatchObject({
      role: "member",
      email: "member@example.test",
      mustChangePassword: false,
    })
  })

  it("records who did what to whom, and never a password", async () => {
    const { s, owner, memberUser, admin, member, put, post } = await setup()
    await put(member, "/profile", { displayName: "Mem" })
    await put(admin, `/users/${memberUser.id}/role`, { role: "admin", adminPassword: PASSWORD })
    await put(admin, `/users/${memberUser.id}/role`, { role: "member", adminPassword: PASSWORD })
    await put(admin, `/users/${memberUser.id}/email`, { email: "renamed@example.test" })
    const reset = await post(admin, `/users/${memberUser.id}/password-reset`, {
      adminPassword: PASSWORD,
    })
    const temporary = String(reset.json.temporaryPassword)
    const changed = await put(admin, "/profile/password", {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    })
    // The change renews the admin's session: they go on with the new cookie and token.
    const renewed = { cookie: cookieOf(changed.headers), csrf: String(changed.json.csrfToken) }
    await post(renewed, "/profile/sessions/end-others")

    const events = listAudit(s.database.db, s.scope)
    const find = (action: string) => events.find((e) => e.action === action)
    expect(find("user.profile")).toMatchObject({ actorId: memberUser.id, targetId: memberUser.id })
    expect(find("user.role")).toMatchObject({
      actorId: owner.id,
      targetId: memberUser.id,
      details: { from: "admin", to: "member" },
    })
    expect(find("user.email")).toMatchObject({
      targetId: memberUser.id,
      details: { from: "member@example.test", to: "renamed@example.test" },
    })
    expect(find("user.password_reset")).toMatchObject({
      actorId: owner.id,
      targetId: memberUser.id,
      details: { generated: true, sessionsEnded: 1 },
    })
    expect(find("user.password_change")).toMatchObject({ actorId: owner.id, targetId: owner.id })
    expect(find("session.end_others")).toMatchObject({ actorId: owner.id })
    expectNoPasswords(JSON.stringify(events), temporary)
    expectNoPasswords(s.logger.lines.join("\n"), temporary)
  })
})

describe("rule: an admin's reset forces a new password before anything else", () => {
  async function resetMember() {
    const base = await setup()
    const { s, memberUser, member, admin, post } = base
    // The member has a playground token from before the reset.
    const created = await s.request("POST", "/api/servers", {
      ...admin,
      body: { slug: "t", name: "T" },
    })
    const serverId = String((created.json.server as { id: string }).id)
    const saved = await s.request("POST", `/api/servers/${serverId}/versions`, {
      ...admin,
      body: { yaml: spec(echoTool("https://api.example.com/x")) },
    })
    const versionId = String((saved.json.version as { id: string }).id)
    const grant = await s.request(
      "POST",
      `/api/servers/${serverId}/versions/${versionId}/playground`,
      { ...member, body: {} },
    )
    const reset = await post(admin, `/users/${memberUser.id}/password-reset`, {
      adminPassword: PASSWORD,
    })
    expect(reset.status).toBe(200)
    return { ...base, reset, serverId, versionId, playgroundToken: String(grant.json.token) }
  }

  it("ends every session and playground token, and shows a generated password once", async () => {
    const { s, member, reset, serverId, playgroundToken } = await resetMember()
    const temporary = String(reset.json.temporaryPassword)
    expect(temporary.length).toBeGreaterThanOrEqual(20)
    expect(reset.json.sessionsEnded).toBe(1)
    expect((await s.request("GET", "/api/me", member)).status).toBe(401)
    const listed = await s.request("POST", `/s/${serverId}/mcp`, {
      headers: {
        authorization: `Bearer ${playgroundToken}`,
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
    expect(listed.status).toBe(401)
    // A password the admin chose is never echoed.
    const { admin, memberUser, post } = await resetMember()
    const chosen = await post(admin, `/users/${memberUser.id}/password-reset`, {
      adminPassword: PASSWORD,
      password: "admin chosen temp pw",
    })
    expect(chosen.json.temporaryPassword).toBeUndefined()
    expect(chosen.text).not.toContain("admin chosen temp pw")
  })

  it("lets the user reach only their profile and the password change until they choose one", async () => {
    const { s, reset, serverId, versionId } = await resetMember()
    const temporary = String(reset.json.temporaryPassword)
    const login = await s.request("POST", "/api/login", {
      body: { email: "member@example.test", password: temporary },
    })
    expect(login.status).toBe(200)
    expect((login.json.user as { mustChangePassword: boolean }).mustChangePassword).toBe(true)
    const session = {
      cookie: (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "",
      csrf: String(login.json.csrfToken),
    }
    const blocked = [
      await s.request("GET", "/api/servers", session),
      await s.request("GET", `/api/servers/${serverId}`, session),
      await s.request("POST", "/api/servers", { ...session, body: { slug: "x", name: "X" } }),
      await s.request("POST", `/api/servers/${serverId}/versions/${versionId}/playground`, {
        ...session,
        body: {},
      }),
      await s.request("PUT", "/api/profile", { ...session, body: { displayName: "x" } }),
      await s.request("GET", "/api/profile/sessions", session),
    ]
    expect(blocked.map((r) => r.status)).toEqual([403, 403, 403, 403, 403, 403])
    expect(blocked[0]?.json.code).toBe("password_change_required")
    // Allowed: who am I, my profile, the change itself.
    expect((await s.request("GET", "/api/session", session)).status).toBe(200)
    expect((await s.request("GET", "/api/me", session)).status).toBe(200)
    expect((await s.request("GET", "/api/profile", session)).status).toBe(200)
    const changed = await s.request("PUT", "/api/profile/password", {
      ...session,
      body: { currentPassword: temporary, newPassword: NEW_PASSWORD },
    })
    expect(changed.status).toBe(200)
    // The session goes on under a new id (the old cookie no longer works), and is free.
    expect((await s.request("GET", "/api/servers", session)).status).toBe(401)
    const renewed = { cookie: cookieOf(changed.headers) }
    expect((await s.request("GET", "/api/servers", renewed)).status).toBe(200)
    expectNoPasswords(changed.text + login.text, temporary)
  })
})

describe("rule: changing your own password ends your other sessions, not this one", () => {
  it("needs the current password and a 12+ character new one", async () => {
    const { member, put } = await setup()
    const wrong = await put(member, "/profile/password", {
      currentPassword: "not my password",
      newPassword: NEW_PASSWORD,
    })
    const short = await put(member, "/profile/password", {
      currentPassword: PASSWORD,
      newPassword: "short",
    })
    const same = await put(member, "/profile/password", {
      currentPassword: PASSWORD,
      newPassword: PASSWORD,
    })
    expect([wrong.status, short.status, same.status]).toEqual([403, 400, 400])
  })

  it("signs out the user's other sessions and their playground tokens", async () => {
    const { s, member, put } = await setup()
    const other = await s.signIn("member@example.test")
    const changed = await put(member, "/profile/password", {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    })
    expect(changed.status).toBe(200)
    expect(changed.json.sessionsEnded).toBe(1)
    // This session goes on, under a new id.
    expect((await s.request("GET", "/api/me", { cookie: cookieOf(changed.headers) })).status).toBe(
      200,
    )
    expect((await s.request("GET", "/api/me", other)).status).toBe(401)
    await expect(s.signIn("member@example.test", NEW_PASSWORD)).resolves.toBeDefined()
  })
})

describe("the profile", () => {
  it("lists the user's sessions without their ids, marks this one, and ends the others", async () => {
    const { s, member, post } = await setup()
    const other = await s.signIn("member@example.test", PASSWORD, "198.51.100.40")
    const listed = await s.request("GET", "/api/profile/sessions", member)
    const sessions = listed.json.sessions as { ref: string; current: boolean; ip: string }[]
    expect(sessions).toHaveLength(2)
    expect(sessions.filter((x) => x.current)).toHaveLength(1)
    expect(sessions.map((x) => x.ip)).toContain("198.51.100.40")
    for (const cookie of [member.cookie, other.cookie]) {
      expect(listed.text).not.toContain(cookie.split("=")[1] ?? "")
    }
    const ended = await post(member, "/profile/sessions/end-others")
    expect(ended.json.sessionsEnded).toBe(1)
    expect((await s.request("GET", "/api/me", other)).status).toBe(401)
    expect((await s.request("GET", "/api/me", member)).status).toBe(200)
  })

  it("ends one other session by its reference", async () => {
    const { s, member } = await setup()
    const other = await s.signIn("member@example.test")
    const listed = await s.request("GET", "/api/profile/sessions", member)
    const ref = (listed.json.sessions as { ref: string; current: boolean }[]).find(
      (x) => !x.current,
    )?.ref
    const ended = await s.request("DELETE", `/api/profile/sessions/${ref}`, { ...member, body: {} })
    expect(ended.status).toBe(200)
    expect((await s.request("GET", "/api/me", other)).status).toBe(401)
  })
})

describe("the web UI's session check", () => {
  it("answers 200 with no user when nobody is signed in (no 401 in the console)", async () => {
    const s = apiStudio()
    studios.push(s)
    const none = await s.request("GET", "/api/session")
    expect(none.status).toBe(200)
    expect(none.json).toEqual({ user: null, setupNeeded: true })
    await s.addUser("admin@example.test", "admin")
    const admin = await s.signIn("admin@example.test")
    const signed = await s.request("GET", "/api/session", admin)
    expect(signed.json.user).toMatchObject({ email: "admin@example.test", role: "admin" })
    expect(signed.json.csrfToken).toBe(admin.csrf)
    expect(String(ORIGIN)).toMatch(/^https:/)
  })

  it("counts setup as the first admin's first sign-in", async () => {
    const s = apiStudio()
    studios.push(s)
    const setup = await s.request("POST", "/api/setup", {
      body: { token: s.setupToken(), email: "first@example.test", password: PASSWORD },
    })
    const id = (setup.json.user as { id: string }).id
    expect(getUser(s.database.db, s.scope, id)?.lastLoginAt).toEqual(expect.any(Number))
  })

  it("records the last sign-in time for the user list", async () => {
    const { s, memberUser } = await setup()
    expect(getUser(s.database.db, s.scope, memberUser.id)?.lastLoginAt).toEqual(expect.any(Number))
    const users = await s.request("GET", "/api/users", await s.signIn("admin@example.test"))
    const listed = (
      users.json.users as { id: string; lastLoginAt: number; createdAt: number }[]
    ).find((u) => u.id === memberUser.id)
    expect(listed).toMatchObject({ lastLoginAt: expect.any(Number), createdAt: expect.any(Number) })
    expect(users.text).not.toContain("passwordHash")
    expect(users.text).not.toContain("scrypt$")
  })
})

describe("the theme preference", () => {
  it("is the user's own, follows them to every session, and starts as system", async () => {
    const { s, admin, member, memberUser, put } = await setup()
    expect((await s.request("GET", "/api/session", member)).json.user).toMatchObject({
      theme: "system",
    })
    const changed = await put(member, "/profile/theme", { theme: "dark" })
    expect(changed.status).toBe(200)
    expect(getUser(s.database.db, s.scope, memberUser.id)?.theme).toBe("dark")
    // Another device: a new session sees the same choice.
    const other = await s.signIn("member@example.test")
    expect((await s.request("GET", "/api/session", other)).json.user).toMatchObject({
      theme: "dark",
    })
    // The admin's choice is untouched.
    expect((await s.request("GET", "/api/session", admin)).json.user).toMatchObject({
      theme: "system",
    })
  })

  it("refuses unknown values and any attempt to name another user", async () => {
    const { s, owner, memberUser, member, put } = await setup()
    const invalid = await put(member, "/profile/theme", { theme: "neon" })
    const otherUser = await put(member, "/profile/theme", { theme: "dark", userId: owner.id })
    const extra = await put(member, "/profile/theme", { theme: "dark", id: owner.id })
    expect([invalid.status, otherUser.status, extra.status]).toEqual([400, 400, 400])
    expect(getUser(s.database.db, s.scope, owner.id)?.theme).toBe("system")
    expect(getUser(s.database.db, s.scope, memberUser.id)?.theme).toBe("system")
    // No CSRF token: refused like every other change.
    const noToken = await s.request("PUT", "/api/profile/theme", {
      cookie: member.cookie,
      body: { theme: "light" },
    })
    expect(noToken.status).toBe(403)
    // Signed out: refused.
    expect(
      (await s.request("PUT", "/api/profile/theme", { body: { theme: "light" } })).status,
    ).toBe(401)
  })

  it("is checked again below the API, and only ever changes the given user in its workspace", async () => {
    const { s, owner, memberUser } = await setup()
    expect(() =>
      setTheme(s.database.db, s.scope, memberUser.id, "neon" as unknown as "dark", ACTOR),
    ).toThrow("Unknown theme.")
    const elsewhere = createWorkspace(s.database.db, "elsewhere")
    expect(() => setTheme(s.database.db, elsewhere, memberUser.id, "dark", ACTOR)).toThrow()
    expect(setTheme(s.database.db, s.scope, memberUser.id, "light", ACTOR)).toBe("light")
    expect(getUser(s.database.db, s.scope, memberUser.id)?.theme).toBe("light")
    expect(getUser(s.database.db, s.scope, owner.id)?.theme).toBe("system")
  })
})
