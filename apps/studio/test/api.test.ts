import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { csrfTokenFor } from "../src/api/routes.js"
import { listAudit } from "../src/db/repos/audit.js"
import { createServer } from "../src/db/repos/servers.js"
import { findSession, SESSION_IDLE_MS } from "../src/db/repos/sessions.js"
import { createWorkspace } from "../src/db/repos/workspaces.js"
import { APP_CSP, isInside } from "../src/web.js"
import { type ApiStudio, apiStudio, cookieOf, ORIGIN, PASSWORD } from "./api-helpers.js"
import { echoTool, spec } from "./helpers.js"

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

function make(options: Parameters<typeof apiStudio>[0] = {}) {
  const s = apiStudio(options)
  studios.push(s)
  return s
}

async function withAdmin(options: Parameters<typeof apiStudio>[0] = {}) {
  const s = make(options)
  await s.addUser("admin@example.test", "admin")
  return { s, admin: await s.signIn("admin@example.test") }
}

describe("first-run setup", () => {
  it("creates the first admin once, with the console token, and signs them in", async () => {
    const s = make()
    expect((await s.request("GET", "/api/setup")).json).toEqual({ needed: true })
    const token = s.setupToken()
    const body = { token, email: "Admin@Example.test", password: PASSWORD }

    expect(
      (await s.request("POST", "/api/setup", { body: { ...body, token: "nope" } })).status,
    ).toBe(403)
    const created = await s.request("POST", "/api/setup", { body })
    expect(created.status).toBe(201)
    expect(created.json).toMatchObject({ user: { email: "admin@example.test", role: "admin" } })
    expect(s.adminCreated()).toBe(1)
    const cookie = created.headers.get("set-cookie") ?? ""
    expect(cookie).toMatch(/^__Host-kervan_session=/)
    expect(cookie).toMatch(/HttpOnly/)
    expect(cookie).toMatch(/Secure/)
    expect(cookie).toMatch(/SameSite=Lax/)
    expect(cookie).toMatch(/Path=\//)
    expect(cookie).not.toMatch(/Domain=/)

    // Setup is closed now, even with a fresh token.
    const again = await s.request("POST", "/api/setup", {
      body: { ...body, token: s.setupToken() },
    })
    expect(again.status).toBe(409)
    expect((await s.request("GET", "/api/setup")).json).toEqual({ needed: false })
  })

  it("refuses a weak password and a cross-origin setup", async () => {
    const s = make()
    const token = s.setupToken()
    const weak = await s.request("POST", "/api/setup", {
      body: { token, email: "a@example.test", password: "short" },
    })
    expect(weak.status).toBe(400)
    const crossOrigin = await s.request("POST", "/api/setup", {
      body: { token, email: "a@example.test", password: PASSWORD },
      headers: { origin: "https://evil.test" },
    })
    expect(crossOrigin.status).toBe(403)
  })
})

describe("login and sessions", () => {
  it("gives the same answer for a wrong password and an unknown account", async () => {
    const s = make()
    await s.addUser("user@example.test", "member")
    const wrong = await s.request("POST", "/api/login", {
      body: { email: "user@example.test", password: "wrong password!" },
    })
    const unknown = await s.request("POST", "/api/login", {
      body: { email: "nobody@example.test", password: "wrong password!" },
      ip: "203.0.113.2",
    })
    expect([wrong.status, unknown.status]).toEqual([401, 401])
    expect(wrong.text).toBe(unknown.text)
    expect(wrong.headers.get("set-cookie")).toBeNull()
  })

  it("issues a new session id at login, whatever cookie the browser sent (fixation)", async () => {
    const { s, admin } = await withAdmin()
    // An attacker plants their own valid session cookie in the victim's browser.
    const planted = admin.cookie
    const response = await s.request("POST", "/api/login", {
      body: { email: "admin@example.test", password: PASSWORD },
      cookie: planted,
    })
    const issued = cookieOf(response.headers)
    expect(issued).not.toBe(planted)
    expect((await s.request("GET", "/api/me", { cookie: issued })).status).toBe(200)
    // The planted id is gone: it cannot be used to ride the victim's new session.
    expect((await s.request("GET", "/api/me", { cookie: planted })).status).toBe(401)
  })

  it("stores only a hash of the session id", async () => {
    const { s, admin } = await withAdmin()
    const id = admin.cookie.split("=")[1] ?? ""
    const rows = JSON.stringify(s.database.sqlite.prepare("SELECT * FROM sessions").all())
    expect(id.length).toBeGreaterThan(20)
    expect(rows).not.toContain(id)
  })

  it("ends a session after the idle timeout", async () => {
    const { s, admin } = await withAdmin()
    const id = admin.cookie.split("=")[1] ?? ""
    expect(findSession(s.database.db, id)).toBeDefined()
    expect(findSession(s.database.db, id, Date.now() + SESSION_IDLE_MS + 1)).toBeUndefined()
    // Expired sessions are deleted, not only refused.
    expect((await s.request("GET", "/api/me", { cookie: admin.cookie })).status).toBe(401)
  })

  it("logs out with the CSRF token only, and the session is gone afterwards", async () => {
    const { s, admin } = await withAdmin()
    expect((await s.request("POST", "/api/logout", { cookie: admin.cookie })).status).toBe(403)
    const out = await s.request("POST", "/api/logout", admin)
    expect(out.status).toBe(200)
    expect(out.headers.get("set-cookie")).toMatch(/Max-Age=0/)
    expect((await s.request("GET", "/api/me", { cookie: admin.cookie })).status).toBe(401)
  })

  it("records logins in the audit log, never the password", async () => {
    const { s } = await withAdmin()
    await s.request("POST", "/api/login", {
      body: { email: "admin@example.test", password: "a wrong password" },
    })
    const events = listAudit(s.database.db, s.scope)
    expect(events.map((event) => event.action)).toEqual(
      expect.arrayContaining(["login.success", "login.failure"]),
    )
    const text = JSON.stringify(events)
    expect(text).not.toContain(PASSWORD)
    expect(text).not.toContain("a wrong password")
    expect(events.find((e) => e.action === "login.failure")?.ip).toBe("203.0.113.1")
  })
})

describe("brute-force protection", () => {
  const fail = (s: ApiStudio, email: string, ip = "198.51.100.7") =>
    s.request("POST", "/api/login", { body: { email, password: "not the password" }, ip })

  it("locks an account after repeated failures, even for the right password", async () => {
    const s = make({ throttle: { accountFailures: 3, ipFailures: 100 } })
    await s.addUser("user@example.test", "member")
    for (let i = 0; i < 3; i++) expect((await fail(s, "user@example.test")).status).toBe(401)
    const locked = await s.request("POST", "/api/login", {
      body: { email: "user@example.test", password: PASSWORD },
      ip: "198.51.100.99",
    })
    expect(locked.status).toBe(429)
    expect(locked.headers.get("retry-after")).toMatch(/^\d+$/)
  })

  it("locks unknown accounts the same way (no account oracle)", async () => {
    const s = make({ throttle: { accountFailures: 3, ipFailures: 100 } })
    await s.addUser("user@example.test", "member")
    for (let i = 0; i < 3; i++) await fail(s, "user@example.test")
    for (let i = 0; i < 3; i++) await fail(s, "ghost@example.test")
    const real = await fail(s, "user@example.test", "198.51.100.50")
    const ghost = await fail(s, "ghost@example.test", "198.51.100.51")
    expect([real.status, ghost.status]).toEqual([429, 429])
    expect(real.text).toBe(ghost.text)
  })

  it("locks a client IP that tries many accounts", async () => {
    const s = make({ throttle: { accountFailures: 100, ipFailures: 4 } })
    await s.addUser("user@example.test", "member")
    for (let i = 0; i < 4; i++) await fail(s, `user${i}@example.test`, "198.51.100.8")
    const blocked = await s.request("POST", "/api/login", {
      body: { email: "user@example.test", password: PASSWORD },
      ip: "198.51.100.8",
    })
    expect(blocked.status).toBe(429)
    // Another client is not affected.
    expect((await s.signIn("user@example.test", PASSWORD, "198.51.100.9")).cookie).toMatch(/=/)
  })

  it("limits setup token guesses per client IP", async () => {
    const s = make({ throttle: { accountFailures: 2, ipFailures: 2 } })
    const guess = () =>
      s.request("POST", "/api/setup", {
        body: { token: "guess", email: "a@example.test", password: PASSWORD },
      })
    expect([(await guess()).status, (await guess()).status]).toEqual([403, 403])
    expect((await guess()).status).toBe(429)
  })
})

describe("CSRF and cross-origin requests", () => {
  const create = (s: ApiStudio, init: Parameters<ApiStudio["request"]>[2]) =>
    s.request("POST", "/api/servers", { body: { slug: "x", name: "X" }, ...init })

  it("needs the session's CSRF token on every state-changing request", async () => {
    const { s, admin } = await withAdmin()
    expect((await create(s, { cookie: admin.cookie })).status).toBe(403)
    expect((await create(s, { cookie: admin.cookie, csrf: "wrong" })).status).toBe(403)
    // Another session's token does not work either.
    await s.addUser("other@example.test", "member")
    const other = await s.signIn("other@example.test")
    expect((await create(s, { cookie: admin.cookie, csrf: other.csrf })).status).toBe(403)
    expect((await create(s, admin)).status).toBe(201)
  })

  it.each([
    ["a foreign Origin", { origin: "https://evil.test" }],
    ["no Origin", { origin: undefined }],
    ['Origin "null" (sandboxed frame)', { origin: "null" }],
    ["another port of Studio's host", { origin: "https://studio.test:8443" }],
    ["plain http of Studio's host", { origin: "http://studio.test" }],
    ["Sec-Fetch-Site: cross-site", { "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site: same-site", { "sec-fetch-site": "same-site" }],
  ])("refuses %s even with a valid session and token", async (_name, headers) => {
    const { s, admin } = await withAdmin()
    const response = await create(s, { ...admin, headers })
    expect(response.status).toBe(403)
    expect((await s.request("GET", "/api/servers", admin)).json).toEqual({ servers: [] })
  })

  it("refuses form posts (no JSON content type)", async () => {
    const { s, admin } = await withAdmin()
    const response = await create(s, {
      ...admin,
      body: "slug=x&name=X",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    })
    expect(response.status).toBe(415)
  })

  it("never sends CORS headers", async () => {
    const { s, admin } = await withAdmin()
    const preflight = await s.request("OPTIONS", "/api/servers", {
      headers: { origin: "https://evil.test", "access-control-request-method": "POST" },
    })
    const read = await s.request("GET", "/api/me", {
      ...admin,
      headers: { origin: "https://evil.test" },
    })
    for (const response of [preflight, read]) {
      expect(response.headers.get("access-control-allow-origin")).toBeNull()
      expect(response.headers.get("access-control-allow-credentials")).toBeNull()
    }
  })

  it("derives the CSRF token from the secret session id", () => {
    expect(csrfTokenFor("a")).not.toBe(csrfTokenFor("b"))
    expect(csrfTokenFor("a")).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe("roles", () => {
  it("lets members edit and publish specs but not manage users or delete servers", async () => {
    const { s, admin } = await withAdmin()
    await s.addUser("member@example.test", "member")
    const member = await s.signIn("member@example.test")

    const created = await s.request("POST", "/api/servers", {
      ...member,
      body: { slug: "weather", name: "Weather" },
    })
    expect(created.status).toBe(201)
    const id = (created.json.server as { id: string }).id
    const saved = await s.request("POST", `/api/servers/${id}/versions`, {
      ...member,
      body: { yaml: spec(echoTool("https://api.example.com/x")) },
    })
    expect(saved.status).toBe(201)
    const versionId = (saved.json.version as { id: string }).id
    const published = await s.request("POST", `/api/servers/${id}/versions/${versionId}/publish`, {
      ...member,
      body: {},
    })
    expect(published.status).toBe(200)

    for (const [method, path, body] of [
      ["GET", "/api/users", undefined],
      [
        "POST",
        "/api/users",
        { email: "x@example.test", password: PASSWORD, role: "admin", adminPassword: PASSWORD },
      ],
      ["DELETE", `/api/servers/${id}`, undefined],
      ["GET", "/api/audit", undefined],
    ] as const) {
      const response = await s.request(method, path, { ...member, ...(body ? { body } : {}) })
      expect(response.status, `${method} ${path}`).toBe(403)
    }
    // The member could not make themselves an admin.
    expect((await s.request("GET", "/api/users", admin)).json.users).toHaveLength(2)

    expect((await s.request("DELETE", `/api/servers/${id}`, admin)).status).toBe(200)
    const added = await s.request("POST", "/api/users", {
      ...admin,
      body: {
        email: "new@example.test",
        password: PASSWORD,
        role: "member",
        adminPassword: PASSWORD,
      },
    })
    expect(added.status).toBe(201)
  })

  it("requires a session for everything but setup and login", async () => {
    const s = make()
    for (const path of ["/api/me", "/api/servers", "/api/users", "/api/audit"]) {
      expect((await s.request("GET", path)).status, path).toBe(401)
    }
  })
})

describe("servers and versions", () => {
  it("saves drafts with line and column issues, refuses to publish them, and exports", async () => {
    const { s, admin } = await withAdmin()
    const id = (
      (await s.request("POST", "/api/servers", { ...admin, body: { slug: "s", name: "S" } })).json
        .server as { id: string }
    ).id
    const broken = await s.request("POST", `/api/servers/${id}/versions`, {
      ...admin,
      body: { yaml: "specVersion: 1\nname: s\nversion: 1.0.0\ntools:\n  - name: bad tool!\n" },
    })
    expect(broken.status).toBe(201)
    expect(broken.json.valid).toBe(false)
    const issue = (broken.json.issues as { line?: number; column?: number }[])[0]
    expect(issue?.line).toBeGreaterThan(0)
    const brokenId = (broken.json.version as { id: string }).id
    const refused = await s.request("POST", `/api/servers/${id}/versions/${brokenId}/publish`, {
      ...admin,
      body: {},
    })
    expect(refused.status).toBe(400)
    expect(refused.json.issues).toBeDefined()

    const good = await s.request("POST", `/api/servers/${id}/versions`, {
      ...admin,
      body: { yaml: spec(echoTool("https://api.example.com/x")) },
    })
    const goodId = (good.json.version as { id: string }).id
    const exported = await s.request("GET", `/api/servers/${id}/versions/${goodId}/export`, admin)
    expect(exported.status).toBe(200)
    expect(exported.headers.get("content-disposition")).toBe('attachment; filename="kervan.yaml"')
    expect(exported.text).toContain("specVersion: 1")
  })

  it("answers 404 for another workspace's server", async () => {
    const { s, admin } = await withAdmin()
    const other = createWorkspace(s.database.db, "other")
    const foreign = createServer(s.database.db, other, { slug: "secret", name: "Secret" })
    for (const path of [`/api/servers/${foreign.id}`]) {
      expect((await s.request("GET", path, admin)).status).toBe(404)
    }
    const saved = await s.request("POST", `/api/servers/${foreign.id}/versions`, {
      ...admin,
      body: { yaml: "x" },
    })
    expect(saved.status).toBe(404)
    expect((await s.request("DELETE", `/api/servers/${foreign.id}`, admin)).status).toBe(404)
  })

  it("answers 409 for a duplicate slug and 400 for a malformed body", async () => {
    const { s, admin } = await withAdmin()
    const body = { slug: "dup", name: "Dup" }
    expect((await s.request("POST", "/api/servers", { ...admin, body })).status).toBe(201)
    expect((await s.request("POST", "/api/servers", { ...admin, body })).status).toBe(409)
    expect((await s.request("POST", "/api/servers", { ...admin, body: "{not json" })).status).toBe(
      400,
    )
  })
})

describe("response headers", () => {
  it("keeps API responses uncacheable and inert", async () => {
    const { s, admin } = await withAdmin()
    const me = await s.request("GET", "/api/me", admin)
    expect(me.headers.get("cache-control")).toBe("no-store")
    expect(me.headers.get("content-security-policy")).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    )
    expect(me.headers.get("x-content-type-options")).toBe("nosniff")
  })

  it("serves the web UI with the app CSP, and nothing outside its folder", async () => {
    const s = make()
    const page = await s.request("GET", "/servers/abc")
    expect(page.status).toBe(200)
    expect(page.text).toContain("<title>Kervan Studio</title>")
    expect(page.headers.get("content-security-policy")).toBe(APP_CSP)
    expect(APP_CSP).toContain("script-src 'self'")
    expect(APP_CSP).not.toMatch(/script-src[^;]*unsafe-(inline|eval)/)
    expect(APP_CSP).toContain("frame-ancestors 'none'")
    const asset = await s.request("GET", "/assets/app-1234.js")
    expect(asset.headers.get("content-type")).toMatch(/^text\/javascript/)
    expect(asset.headers.get("cache-control")).toMatch(/immutable/)
    // secret.txt sits right next to the web root.
    for (const path of [
      "/..%2fsecret.txt",
      "/%2e%2e/secret.txt",
      "/%2e%2e%2fsecret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/..%5csecret.txt",
      "/%2e%2e%5csecret.txt",
      "/assets/missing.js",
    ]) {
      const response = await s.request("GET", path)
      expect(response.status, path).toBe(404)
      expect(response.text, path).not.toContain("TOP-SECRET")
    }
  })

  it("refuses dot segments even when they stay inside the web root", async () => {
    const s = make()
    // An encoded slash keeps ".." as a segment past URL normalization; index.html exists.
    for (const path of ["/assets/..%2findex.html", "/assets/%2e%2e%2findex.html"]) {
      expect((await s.request("GET", path)).status, path).toBe(404)
    }
  })

  it("checks containment by directory, not by string prefix", () => {
    const base = path.resolve("/srv/web")
    expect(isInside(base, base)).toBe(true)
    expect(isInside(base, path.join(base, "assets", "a.js"))).toBe(true)
    expect(isInside(base, path.resolve("/srv/web2/a.js"))).toBe(false)
    expect(isInside(base, path.resolve("/srv/webroot"))).toBe(false)
    expect(isInside(base, path.resolve("/srv/secret.txt"))).toBe(false)
  })

  it("does not answer unknown API paths with the web UI", async () => {
    const s = make()
    const response = await s.request("GET", "/api/nope")
    expect(response.status).toBe(404)
    expect(response.json).toEqual({ error: "Not found." })
  })
})

it("uses Studio's public origin for every check", () => {
  expect(ORIGIN).toBe("https://studio.test")
})
