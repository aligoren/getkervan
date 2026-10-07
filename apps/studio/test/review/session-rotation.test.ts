// Changing one's own password renews the session that made the change: a new id (cookie) and a
// new CSRF token, and the old cookie stops working. Someone holding a copy of that cookie, taken
// before the change, is out like the user's other sessions.
import { afterEach, describe, expect, it } from "vitest"
import { type ApiStudio, apiStudio, cookieOf, PASSWORD } from "../api-helpers.js"

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

const NEW_PASSWORD = "a brand new password 42"

describe("a password change", () => {
  it("renews the session: new cookie and CSRF token, the old cookie no longer works", async () => {
    const s = apiStudio()
    studios.push(s)
    await s.addUser("member@example.test", "member")
    const before = await s.signIn("member@example.test")
    // A copy of the cookie, as someone who stole it would hold it.
    const stolen = { ...before }

    const changed = await s.request("PUT", "/api/profile/password", {
      ...before,
      body: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    })
    expect(changed.status).toBe(200)
    const after = { cookie: cookieOf(changed.headers), csrf: String(changed.json.csrfToken) }
    expect(after.cookie).not.toBe("")
    expect(after.cookie).not.toBe(before.cookie)
    expect(after.csrf).not.toBe(before.csrf)
    // The new cookie keeps the same security attributes.
    expect(changed.headers.get("set-cookie")).toMatch(/HttpOnly/i)
    expect(changed.headers.get("set-cookie")).toMatch(/SameSite=Lax/i)

    // The old cookie is gone, for reading and for writing.
    expect((await s.request("GET", "/api/me", { cookie: stolen.cookie })).status).toBe(401)
    expect(
      (
        await s.request("PUT", "/api/profile", {
          ...stolen,
          body: { displayName: "Stolen" },
        })
      ).status,
    ).toBe(401)

    // The new session works, with its own token only.
    const me = await s.request("GET", "/api/me", { cookie: after.cookie })
    expect(me.status).toBe(200)
    expect(me.json.csrfToken).toBe(after.csrf)
    expect(
      (
        await s.request("PUT", "/api/profile", {
          cookie: after.cookie,
          csrf: before.csrf,
          body: { displayName: "Deniz" },
        })
      ).status,
    ).toBe(403)
    expect(
      (await s.request("PUT", "/api/profile", { ...after, body: { displayName: "Deniz" } })).status,
    ).toBe(200)
  })

  it("after an admin's reset, gives the user a fresh session that is no longer held back", async () => {
    const s = apiStudio()
    studios.push(s)
    await s.addUser("admin@example.test", "admin")
    const member = await s.addUser("member@example.test", "member")
    const admin = await s.signIn("admin@example.test")
    const reset = await s.request("POST", `/api/users/${member.id}/password-reset`, {
      ...admin,
      body: { adminPassword: PASSWORD, password: "temporary password 77" },
    })
    expect(reset.status).toBe(200)

    const gated = await s.signIn("member@example.test", "temporary password 77")
    expect((await s.request("GET", "/api/servers", { cookie: gated.cookie })).status).toBe(403)
    const changed = await s.request("PUT", "/api/profile/password", {
      ...gated,
      body: { currentPassword: "temporary password 77", newPassword: NEW_PASSWORD },
    })
    expect(changed.status).toBe(200)
    const fresh = cookieOf(changed.headers)
    expect(fresh).not.toBe(gated.cookie)
    expect((await s.request("GET", "/api/me", { cookie: gated.cookie })).status).toBe(401)
    expect((await s.request("GET", "/api/servers", { cookie: fresh })).status).toBe(200)
  })

  it("does not renew the session when the change is refused", async () => {
    const s = apiStudio()
    studios.push(s)
    await s.addUser("member@example.test", "member")
    const session = await s.signIn("member@example.test")
    const refused = await s.request("PUT", "/api/profile/password", {
      ...session,
      body: { currentPassword: "not the password!", newPassword: NEW_PASSWORD },
    })
    expect(refused.status).toBe(403)
    expect(refused.headers.get("set-cookie")).toBeNull()
    expect((await s.request("GET", "/api/me", { cookie: session.cookie })).status).toBe(200)
  })
})
