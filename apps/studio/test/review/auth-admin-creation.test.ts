// Security review (release): a stolen admin session alone cannot make a new admin (T6). Adding a
// user, like a role change, needs the admin's own password, checked on the server.
import { afterEach, describe, expect, it } from "vitest"
import { type ApiStudio, apiStudio, PASSWORD } from "../api-helpers.js"

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

describe("a stolen admin session alone", () => {
  it("cannot make a new admin by adding one (no admin password asked)", async () => {
    const s = apiStudio()
    studios.push(s)
    await s.addUser("admin@example.test", "admin")
    // What an attacker holds: the cookie and CSRF token of the admin's session, not the password.
    const stolen = await s.signIn("admin@example.test")

    const backdoor = { email: "backdoor@example.test", password: "attacker password 123" }
    const missing = await s.request("POST", "/api/users", {
      ...stolen,
      body: { ...backdoor, role: "admin" },
    })
    const wrong = await s.request("POST", "/api/users", {
      ...stolen,
      body: { ...backdoor, role: "admin", adminPassword: "a guess at it" },
    })
    // The same bar as a role change: refused without the admin's own password.
    expect([missing.status, wrong.status]).toEqual([400, 403])

    // And the attacker does not end up with a persistent admin account.
    const login = await s.request("POST", "/api/login", {
      body: { email: "backdoor@example.test", password: "attacker password 123" },
      ip: "198.51.100.9",
    })
    expect(login.status).toBe(401)

    // With the password, the admin adds the user.
    const added = await s.request("POST", "/api/users", {
      ...stolen,
      body: { ...backdoor, role: "member", adminPassword: PASSWORD },
    })
    expect(added.status).toBe(201)
  })
})
