// Security review (release): checks that held up, kept as regression tests. The races use the
// same pause inside a mocked scrypt as auth-password-races.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest"
import { rateLimitKey } from "../../src/client-ip.js"
import { findSession } from "../../src/db/repos/sessions.js"
import { listUsers } from "../../src/db/repos/users.js"
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
  it("after an admin's reset, gets a session that can only change the password", async () => {
    const s = make()
    await s.addUser("admin@example.test", "admin")
    const target = await s.addUser("target@example.test", "member")
    const admin = await s.signIn("admin@example.test")

    const held = arm("verify", PASSWORD)
    const login = s.request("POST", "/api/login", {
      body: { email: "target@example.test", password: PASSWORD },
      ip: "198.51.100.70",
    })
    await held.reached
    const reset = await s.request("POST", `/api/users/${target.id}/password-reset`, {
      ...admin,
      body: { adminPassword: PASSWORD, password: "temporary password 77" },
    })
    expect(reset.status).toBe(200)
    held.release()
    const late = await login
    const cookie = late.status === 200 ? cookieOf(late.headers) : ""
    const servers = await s.request("GET", "/api/servers", { cookie })
    expect(servers.status === 401 || servers.json.code === "password_change_required").toBe(true)
  })

  it("after deactivation, gets no working session", async () => {
    const s = make()
    await s.addUser("admin@example.test", "admin")
    const target = await s.addUser("target@example.test", "member")
    const admin = await s.signIn("admin@example.test")

    const held = arm("verify", PASSWORD)
    const login = s.request("POST", "/api/login", {
      body: { email: "target@example.test", password: PASSWORD },
      ip: "198.51.100.71",
    })
    await held.reached
    const off = await s.request("PUT", `/api/users/${target.id}`, {
      ...admin,
      body: { disabled: true },
    })
    expect(off.status).toBe(200)
    held.release()
    const late = await login
    const cookie = late.status === 200 ? cookieOf(late.headers) : ""
    expect((await s.request("GET", "/api/me", { cookie })).status).toBe(401)
  })
})

describe("first-run setup", () => {
  it("makes exactly one admin when two requests race with the same token", async () => {
    const s = make()
    const token = s.setupToken()
    const [a, b] = await Promise.all([
      s.request("POST", "/api/setup", {
        body: { token, email: "one@example.test", password: PASSWORD },
        ip: "127.0.0.1",
      }),
      s.request("POST", "/api/setup", {
        body: { token, email: "two@example.test", password: PASSWORD },
        ip: "127.0.0.1",
      }),
    ])
    expect([a.status, b.status].sort()).toEqual([201, 409].sort())
    expect(listUsers(s.database.db, s.scope).filter((u) => u.role === "admin")).toHaveLength(1)
    expect(s.adminCreated()).toBe(1)
  })
})

describe("state-changing routes", () => {
  it("are not reachable with HEAD or a method-override header", async () => {
    const s = make()
    await s.addUser("admin@example.test", "admin")
    const admin = await s.signIn("admin@example.test")
    const head = await s.request("HEAD", "/api/logout", admin)
    expect(head.status).not.toBe(200)
    const override = await s.request("GET", "/api/logout", {
      ...admin,
      headers: { "x-http-method-override": "POST", "x-method-override": "POST" },
    })
    expect(override.status).toBe(404)
    // Still signed in.
    expect((await s.request("GET", "/api/me", admin)).status).toBe(200)
  })
})

describe("sessions", () => {
  it("signing in from a browser holding another user's session ends that session", async () => {
    const s = make()
    await s.addUser("first@example.test", "member")
    await s.addUser("second@example.test", "member")
    const first = await s.signIn("first@example.test")
    const second = await s.request("POST", "/api/login", {
      cookie: first.cookie,
      body: { email: "second@example.test", password: PASSWORD },
    })
    expect(second.status).toBe(200)
    expect((await s.request("GET", "/api/me", first)).status).toBe(401)
    const id = first.cookie.split("=")[1] ?? ""
    expect(findSession(s.database.db, id)).toBeUndefined()
  })

  it("a demoted admin's open session loses admin routes at once", async () => {
    const s = make()
    const demoted = await s.addUser("demoted@example.test", "admin")
    await s.addUser("other@example.test", "admin")
    const session = await s.signIn("demoted@example.test")
    const other = await s.signIn("other@example.test")
    expect((await s.request("GET", "/api/users", session)).status).toBe(200)
    const change = await s.request("PUT", `/api/users/${demoted.id}/role`, {
      ...other,
      body: { role: "member", adminPassword: PASSWORD },
    })
    expect(change.status).toBe(200)
    expect((await s.request("GET", "/api/users", session)).status).toBe(403)
  })

  it("a user who must change their password gets no playground token or server list", async () => {
    const s = make()
    await s.addUser("admin@example.test", "admin")
    const target = await s.addUser("target@example.test", "member")
    const admin = await s.signIn("admin@example.test")
    const created = await s.request("POST", "/api/servers", {
      ...admin,
      body: { slug: "t", name: "T" },
    })
    const serverId = String((created.json.server as { id: string }).id)
    const saved = await s.request("POST", `/api/servers/${serverId}/versions`, {
      ...admin,
      body: { yaml: "specVersion: 1\n" },
    })
    const versionId = String((saved.json.version as { id: string }).id)
    await s.request("POST", `/api/users/${target.id}/password-reset`, {
      ...admin,
      body: { adminPassword: PASSWORD, password: "temporary password 77" },
    })
    const user = await s.signIn("target@example.test", "temporary password 77")
    const grant = await s.request(
      "POST",
      `/api/servers/${serverId}/versions/${versionId}/playground`,
      { ...user, body: {} },
    )
    expect(grant.status).toBe(403)
    expect(grant.json.code).toBe("password_change_required")
  })
})

describe("rate-limit keys", () => {
  it("count every spelling of one IPv6 /64 together, and other /64s apart", () => {
    const key = rateLimitKey("2001:db8:1:2::1")
    expect(rateLimitKey("2001:0DB8:0001:0002:ffff:ffff:ffff:ffff")).toBe(key)
    expect(rateLimitKey("2001:db8:1:2:0:0:0:abcd")).toBe(key)
    expect(rateLimitKey("2001:db8:1:2::1%eth0")).toBe(key)
    expect(rateLimitKey("2001:db8:1:3::1")).not.toBe(key)
    expect(rateLimitKey("203.0.113.5")).toBe("203.0.113.5")
  })
})
