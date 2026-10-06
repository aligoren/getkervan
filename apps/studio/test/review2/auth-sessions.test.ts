// Independent review (phase 4 complete): management API authentication, sessions, setup and
// login throttling. Each test asserts the secure behavior; a failing test is a finding.
import { afterEach, describe, expect, it } from "vitest"
import { findSession, SESSION_ABSOLUTE_MS } from "../../src/db/repos/sessions.js"
import { issueSetupToken, SETUP_TOKEN_TTL_MS } from "../../src/db/repos/tokens.js"
import { type ApiStudio, apiStudio, cookieOf, PASSWORD } from "../api-helpers.js"

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

function make(options: Parameters<typeof apiStudio>[0] = {}) {
  const s = apiStudio(options)
  studios.push(s)
  return s
}

const wrong = (s: ApiStudio, email: string, ip: string) =>
  s.request("POST", "/api/login", { body: { email, password: "not the password!" }, ip })

describe("session cookie", () => {
  it("is HttpOnly, SameSite=Lax, Secure, __Host- prefixed, Path=/ and has no Domain", async () => {
    const s = make()
    await s.addUser("admin@example.test", "admin")
    const login = await s.request("POST", "/api/login", {
      body: { email: "admin@example.test", password: PASSWORD },
    })
    const header = login.headers.get("set-cookie") ?? ""
    expect(header).toMatch(/^__Host-kervan_session=/)
    expect(header).toMatch(/;\s*HttpOnly/i)
    expect(header).toMatch(/;\s*Secure/i)
    expect(header).toMatch(/;\s*SameSite=Lax/i)
    expect(header).toMatch(/;\s*Path=\/(;|$)/i)
    expect(header).not.toMatch(/;\s*Domain=/i)
  })

  it("is set with the same flags by setup", async () => {
    const s = make()
    const setup = await s.request("POST", "/api/setup", {
      body: { token: s.setupToken(), email: "first@example.test", password: PASSWORD },
    })
    expect(setup.status).toBe(201)
    const header = setup.headers.get("set-cookie") ?? ""
    expect(header).toMatch(/^__Host-kervan_session=/)
    expect(header).toMatch(/HttpOnly/i)
    expect(header).toMatch(/Secure/i)
  })

  it("is cleared under its own (prefixed) name at logout", async () => {
    const s = make()
    await s.addUser("admin@example.test", "admin")
    const admin = await s.signIn("admin@example.test")
    const out = await s.request("POST", "/api/logout", admin)
    expect(out.status).toBe(200)
    expect(out.headers.get("set-cookie") ?? "").toMatch(/^__Host-kervan_session=;/)
  })
})

describe("session lifetime", () => {
  it("ends after 24 hours even when the session is used all the time", async () => {
    const s = make()
    await s.addUser("admin@example.test", "admin")
    const admin = await s.signIn("admin@example.test")
    const id = admin.cookie.split("=")[1] ?? ""
    const start = Date.now()
    // Active every 30 minutes: never idle.
    for (let t = 0; t < SESSION_ABSOLUTE_MS - 60_000; t += 30 * 60_000) {
      expect(findSession(s.database.db, id, start + t), `at +${t} ms`).toBeDefined()
    }
    expect(findSession(s.database.db, id, start + SESSION_ABSOLUTE_MS + 1)).toBeUndefined()
    // Deleted, not only refused.
    expect((await s.request("GET", "/api/me", { cookie: admin.cookie })).status).toBe(401)
  })

  it("does not accept a session cookie after logout, even with the CSRF token", async () => {
    const s = make()
    await s.addUser("admin@example.test", "admin")
    const admin = await s.signIn("admin@example.test")
    await s.request("POST", "/api/logout", admin)
    const after = await s.request("POST", "/api/servers", {
      ...admin,
      body: { slug: "after-logout", name: "x" },
    })
    expect(after.status).toBe(401)
  })
})

describe("first-run setup", () => {
  it("refuses an expired token", async () => {
    const s = make()
    const { token } = issueSetupToken(s.database.db, Date.now() - SETUP_TOKEN_TTL_MS - 1)
    const response = await s.request("POST", "/api/setup", {
      body: { token, email: "a@example.test", password: PASSWORD },
    })
    expect(response.status).toBe(403)
  })

  it("is closed once an admin exists, even with a fresh valid token", async () => {
    const s = make()
    await s.addUser("admin@example.test", "admin")
    const response = await s.request("POST", "/api/setup", {
      body: { token: s.setupToken(), email: "second@example.test", password: PASSWORD },
    })
    expect(response.status).toBe(409)
    expect(response.headers.get("set-cookie")).toBeNull()
  })

  // T7: "setup-token guesses are limited per IP too". The setup endpoint counts its failures under
  // the fixed account key "setup", so failures from *other* clients lock it for everyone.
  it("limits setup token guesses per client IP, not for every client at once", async () => {
    const s = make() // default limits: 5 per account, 20 per IP
    const token = s.setupToken()
    for (let i = 0; i < 5; i++) {
      const guess = await s.request("POST", "/api/setup", {
        body: { token: `guess-${i}`, email: "a@example.test", password: PASSWORD },
        ip: `198.51.100.${10 + i}`,
      })
      expect(guess.status).toBe(403)
    }
    // The operator, from another address, with the real token.
    const real = await s.request("POST", "/api/setup", {
      body: { token, email: "owner@example.test", password: PASSWORD },
      ip: "192.0.2.77",
    })
    expect(real.status, real.text).toBe(201)
  })

  it("is not locked by failed logins for an account named 'setup'", async () => {
    const s = make()
    const token = s.setupToken()
    for (let i = 0; i < 5; i++) await wrong(s, "setup", `198.51.100.${30 + i}`)
    const real = await s.request("POST", "/api/setup", {
      body: { token, email: "owner@example.test", password: PASSWORD },
      ip: "192.0.2.78",
    })
    expect(real.status, real.text).toBe(201)
  })
})

describe("login throttling", () => {
  // T7: "5 failures for an account ... within 15 minutes lock it". The lock is checked before the
  // (slow, asynchronous) password check and failures are counted after it, so concurrent guesses
  // all get through.
  it("lets no more than the allowed number of guesses through when they arrive at once", async () => {
    const s = make({ throttle: { accountFailures: 5, ipFailures: 1000 } })
    await s.addUser("victim@example.test", "member")
    const attempts = await Promise.all(
      Array.from({ length: 30 }, (_, i) => wrong(s, "victim@example.test", `198.51.100.${i + 1}`)),
    )
    const checked = attempts.filter((r) => r.status === 401).length
    expect(checked, `${checked} of 30 concurrent guesses were checked`).toBeLessThanOrEqual(5)
  })

  it("does not accept the right password inside a burst once the account is over its limit", async () => {
    const s = make({ throttle: { accountFailures: 5, ipFailures: 1000 } })
    await s.addUser("victim@example.test", "member")
    const guesses = Array.from({ length: 29 }, (_, i) =>
      wrong(s, "victim@example.test", `198.51.100.${i + 1}`),
    )
    // The 30th guess in the burst is the right one.
    const right = s.request("POST", "/api/login", {
      body: { email: "victim@example.test", password: PASSWORD },
      ip: "198.51.100.200",
    })
    const results = await Promise.all([...guesses, right])
    expect(results.at(-1)?.status).toBe(429)
  })

  // T7 counts failures "per client IP"; T12 says IPv6 clients are counted per /64 because one host
  // usually holds a whole /64. The login throttle keys on the full address instead.
  it("counts IPv6 clients per /64, like the request limit", async () => {
    const s = make({ throttle: { accountFailures: 1000, ipFailures: 4 } })
    for (let i = 1; i <= 4; i++) {
      expect((await wrong(s, `user${i}@example.test`, `2001:db8:1:2::${i}`)).status).toBe(401)
    }
    // Same /64, next address.
    const next = await wrong(s, "user5@example.test", "2001:db8:1:2::ffff")
    expect(next.status).toBe(429)
  })

  it("locks the account however its email is written (case, spaces)", async () => {
    const s = make({ throttle: { accountFailures: 3, ipFailures: 1000 } })
    await s.addUser("victim@example.test", "member")
    for (const form of ["victim@example.test", "VICTIM@example.test", " Victim@Example.Test "]) {
      await wrong(s, form, "198.51.100.1")
    }
    const locked = await s.request("POST", "/api/login", {
      body: { email: "victim@EXAMPLE.test", password: PASSWORD },
      ip: "198.51.100.2",
    })
    expect(locked.status).toBe(429)
  })

  it("gives a locked known account and a locked unknown account the same answer", async () => {
    const s = make({ throttle: { accountFailures: 2, ipFailures: 1000 } })
    await s.addUser("real@example.test", "member")
    for (let i = 0; i < 2; i++) {
      await wrong(s, "real@example.test", "198.51.100.1")
      await wrong(s, "ghost@example.test", "198.51.100.1")
    }
    const real = await wrong(s, "real@example.test", "198.51.100.3")
    const ghost = await wrong(s, "ghost@example.test", "198.51.100.4")
    expect([real.status, ghost.status]).toEqual([429, 429])
    expect(real.text).toBe(ghost.text)
    expect(real.headers.get("retry-after")).toBe(ghost.headers.get("retry-after"))
  })

  it("never sets a cookie on a failed or throttled login", async () => {
    const s = make({ throttle: { accountFailures: 1, ipFailures: 1000 } })
    await s.addUser("real@example.test", "member")
    const failed = await wrong(s, "real@example.test", "198.51.100.1")
    const locked = await s.request("POST", "/api/login", {
      body: { email: "real@example.test", password: PASSWORD },
      ip: "198.51.100.2",
    })
    expect(failed.headers.get("set-cookie")).toBeNull()
    expect(locked.status).toBe(429)
    expect(locked.headers.get("set-cookie")).toBeNull()
    expect(cookieOf(locked.headers)).toBe("")
  })
})
