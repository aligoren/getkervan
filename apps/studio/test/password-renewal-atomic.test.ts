// Changing one's own password writes the new password, ends the other sessions, deletes the old
// session and creates its successor in one transaction (BEGIN IMMEDIATE). A failure in the middle
// (here: creating the new session) leaves all of it as it was: the old password, the old session,
// the other sessions, and no audit event.
import { afterEach, describe, expect, it, vi } from "vitest"
import { changeOwnPassword } from "../src/accounts.js"
import { listAudit } from "../src/db/repos/audit.js"
import { countSessions } from "../src/db/repos/sessions.js"
import { type ApiStudio, apiStudio, PASSWORD } from "./api-helpers.js"

const failing = vi.hoisted(() => ({ createSession: false }))
vi.mock("../src/db/repos/sessions.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/db/repos/sessions.js")>()
  return {
    ...original,
    createSession: (...args: Parameters<typeof original.createSession>) => {
      if (failing.createSession) throw new Error("injected: the new session could not be stored")
      return original.createSession(...args)
    },
  }
})

const studios: ApiStudio[] = []
afterEach(async () => {
  failing.createSession = false
  for (const s of studios.splice(0)) await s.close()
})

const NEW_PASSWORD = "a brand new password 42"

describe("a password change that fails half way", () => {
  it("leaves the old password, the old session and the other sessions (API)", async () => {
    const s = apiStudio()
    studios.push(s)
    const member = await s.addUser("member@example.test", "member")
    const current = await s.signIn("member@example.test")
    const other = await s.signIn("member@example.test", PASSWORD, "203.0.113.50")
    expect(countSessions(s.database.db, s.scope, member.id)).toBe(2)

    failing.createSession = true
    const changed = await s.request("PUT", "/api/profile/password", {
      ...current,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    })
    failing.createSession = false
    expect(changed.status).toBe(500)
    expect(changed.headers.get("set-cookie")).toBeNull()

    // Both sessions still work, with their own CSRF tokens.
    for (const session of [current, other]) {
      const me = await s.request("GET", "/api/me", { cookie: session.cookie })
      expect(me.status).toBe(200)
      expect(me.json.csrfToken).toBe(session.csrf)
    }
    expect(countSessions(s.database.db, s.scope, member.id)).toBe(2)
    // The old password still signs in; the new one does not.
    expect(
      (
        await s.request("POST", "/api/login", {
          body: { email: "member@example.test", password: NEW_PASSWORD },
        })
      ).status,
    ).toBe(401)
    await s.signIn("member@example.test")
    expect(listAudit(s.database.db, s.scope, { action: "user.password_change" })).toEqual([])
  })

  it("leaves everything as it was when renewing throws (accounts)", async () => {
    const s = apiStudio()
    studios.push(s)
    const member = await s.addUser("member@example.test", "member")
    await s.signIn("member@example.test")
    const sessionHash = s.database.sqlite
      .prepare("SELECT id_hash AS hash FROM sessions WHERE user_id = ?")
      .get(member.id) as { hash: string }
    const before = s.database.sqlite
      .prepare("SELECT password_hash FROM users WHERE id = ?")
      .get(member.id)
    const error = await changeOwnPassword(
      s.database.db,
      s.scope,
      member.id,
      { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      sessionHash.hash,
      { type: "user", id: member.id },
      () => {
        throw new Error("injected")
      },
    ).catch((e: unknown) => e)
    expect((error as Error).message).toBe("injected")
    expect(
      s.database.sqlite.prepare("SELECT password_hash FROM users WHERE id = ?").get(member.id),
    ).toEqual(before)
    expect(countSessions(s.database.db, s.scope, member.id)).toBe(1)
    expect(listAudit(s.database.db, s.scope, { action: "user.password_change" })).toEqual([])
  })

  it("on success, only the renewed session is left", async () => {
    const s = apiStudio()
    studios.push(s)
    const member = await s.addUser("member@example.test", "member")
    const current = await s.signIn("member@example.test")
    await s.signIn("member@example.test", PASSWORD, "203.0.113.50")
    const changed = await s.request("PUT", "/api/profile/password", {
      ...current,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    })
    expect(changed.status).toBe(200)
    expect(changed.json.sessionsEnded).toBe(1)
    expect(countSessions(s.database.db, s.scope, member.id)).toBe(1)
    expect((await s.request("GET", "/api/me", { cookie: current.cookie })).status).toBe(401)
  })
})
