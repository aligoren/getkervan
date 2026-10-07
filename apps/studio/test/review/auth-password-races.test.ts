// Security review (release): check-then-act races around passwords and admin actions. A request's
// checks (password, role, session) happen before an `await` on scrypt, so the write that follows
// checks again. A pause inside the mocked scrypt makes each race deterministic.
import { afterEach, describe, expect, it, vi } from "vitest"
import { getUser } from "../../src/db/repos/users.js"
import { type ApiStudio, apiStudio, cookieOf, PASSWORD } from "../api-helpers.js"
import { arm } from "./hold.js"

vi.mock("../../src/crypto.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/crypto.js")>()
  const { maybeHold } = await import("./hold.js")
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

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

function make() {
  const s = apiStudio()
  studios.push(s)
  return s
}

describe("an in-flight sign-in with the old password", () => {
  it("does not outlive the user's own password change (attacker keeps a fresh session)", async () => {
    const s = make()
    await s.addUser("victim@example.test", "member")
    const victim = await s.signIn("victim@example.test")

    // The attacker knows the old password and is signing in right now.
    const held = arm("verify", PASSWORD)
    const attackerLogin = s.request("POST", "/api/login", {
      body: { email: "victim@example.test", password: PASSWORD },
      ip: "198.51.100.66",
    })
    await held.reached

    // The victim notices and changes the password: "every other session ends".
    const change = await s.request("PUT", "/api/profile/password", {
      ...victim,
      body: { currentPassword: PASSWORD, newPassword: "a brand new password 42" },
    })
    expect(change.status).toBe(200)

    held.release()
    const login = await attackerLogin
    // Either the sign-in is refused, or the session it created does not work.
    const cookie = login.status === 200 ? cookieOf(login.headers) : ""
    const me = await s.request("GET", "/api/me", { cookie })
    expect(me.status).toBe(401)
  })
})

describe("an admin's password reset", () => {
  it("is not undone by the user's own password change that was already in flight", async () => {
    const s = make()
    await s.addUser("admin@example.test", "admin")
    const target = await s.addUser("target@example.test", "member")
    const attacker = await s.signIn("target@example.test")
    const admin = await s.signIn("admin@example.test")

    const attackerPassword = "attacker chosen password 1"
    const held = arm("hash", attackerPassword)
    const change = s.request("PUT", "/api/profile/password", {
      ...attacker,
      body: { currentPassword: PASSWORD, newPassword: attackerPassword },
    })
    await held.reached

    // The admin resets the account (incident response): temporary password, must change it.
    const reset = await s.request("POST", `/api/users/${target.id}/password-reset`, {
      ...admin,
      body: { adminPassword: PASSWORD, password: "temporary password 77" },
    })
    expect(reset.status).toBe(200)

    held.release()
    await change

    // The reset must win: the attacker's password must not work, and the flag must stay set.
    const login = await s.request("POST", "/api/login", {
      body: { email: "target@example.test", password: attackerPassword },
      ip: "198.51.100.67",
    })
    expect(login.status).toBe(401)
    expect(getUser(s.database.db, s.scope, target.id)?.mustChangePassword).toBe(true)
  })
})

describe("an admin action already in flight", () => {
  it("does not complete after its admin was deactivated by another admin", async () => {
    const s = make()
    const rogue = await s.addUser("rogue@example.test", "admin")
    await s.addUser("good@example.test", "admin")
    const member = await s.addUser("accomplice@example.test", "member")
    const rogueSession = await s.signIn("rogue@example.test")
    const good = await s.signIn("good@example.test")

    // The rogue admin promotes an accomplice; the request is past its role check, confirming the
    // rogue's password.
    const held = arm("verify", PASSWORD)
    const promote = s.request("PUT", `/api/users/${member.id}/role`, {
      ...rogueSession,
      body: { role: "admin", adminPassword: PASSWORD },
    })
    await held.reached

    // Meanwhile the other admin deactivates the rogue (their sessions end).
    const disable = await s.request("PUT", `/api/users/${rogue.id}`, {
      ...good,
      body: { disabled: true, revokeKeys: true },
    })
    expect(disable.status).toBe(200)

    held.release()
    const result = await promote
    expect(result.status).not.toBe(200)
    expect(getUser(s.database.db, s.scope, member.id)?.role).toBe("member")
  })

  it("does not create an admin after its admin was demoted", async () => {
    const s = make()
    const rogue = await s.addUser("rogue@example.test", "admin")
    await s.addUser("good@example.test", "admin")
    const rogueSession = await s.signIn("rogue@example.test")
    const good = await s.signIn("good@example.test")

    const backdoorPassword = "backdoor admin password 9"
    const held = arm("hash", backdoorPassword)
    const create = s.request("POST", "/api/users", {
      ...rogueSession,
      body: {
        email: "backdoor@example.test",
        password: backdoorPassword,
        role: "admin",
        adminPassword: PASSWORD,
      },
    })
    await held.reached

    const demote = await s.request("PUT", `/api/users/${rogue.id}/role`, {
      ...good,
      body: { role: "member", adminPassword: PASSWORD },
    })
    expect(demote.status).toBe(200)

    held.release()
    const result = await create
    expect(result.status).not.toBe(201)
    const login = await s.request("POST", "/api/login", {
      body: { email: "backdoor@example.test", password: backdoorPassword },
      ip: "198.51.100.68",
    })
    expect(login.status).toBe(401)
  })
})
