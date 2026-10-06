// Independent review: static file serving (traversal, headers) and request-size/rate limits (T4,
// T12) through Studio's whole HTTP app.
import { afterEach, describe, expect, it } from "vitest"
import { API_MAX_BODY_BYTES } from "../../src/api/routes.js"
import { APP_CSP } from "../../src/web.js"
import { type ApiStudio, apiStudio } from "../api-helpers.js"

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

function make() {
  const s = apiStudio()
  studios.push(s)
  return s
}

describe("static files", () => {
  const attempts = [
    "/../secret.txt",
    "/..%2fsecret.txt",
    "/%2e%2e/secret.txt",
    "/%2e%2e%2fsecret.txt",
    "/.%2e/secret.txt",
    "/%252e%252e/secret.txt",
    "/assets/..%2f..%2fsecret.txt",
    "/assets/%2e%2e%5c%2e%2e%5csecret.txt",
    "/%5c..%5csecret.txt",
    "/..%5csecret.txt",
    "/..%c0%afsecret.txt",
    "/%00/../secret.txt",
    "/index.html%00.js",
    "/assets/../../secret.txt",
    "/index.html::$DATA",
    "/C:/Windows/win.ini",
    "/%43:%5cWindows%5cwin.ini",
  ]

  it.each(attempts)("never serves a file outside the web root: %s", async (path) => {
    const s = make()
    const response = await s.request("GET", path)
    expect(response.text).not.toContain("TOP-SECRET-OUTSIDE-WEB-ROOT")
    expect(response.text).not.toMatch(/\[fonts\]|\[extensions\]/i)
  })

  it("serves the app shell for client routes with the app CSP and frame protection", async () => {
    const s = make()
    const response = await s.request("GET", "/servers/anything")
    expect(response.status).toBe(200)
    expect(response.headers.get("content-security-policy")).toBe(APP_CSP)
    expect(response.headers.get("x-frame-options")).toBe("DENY")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(APP_CSP).toMatch(/script-src 'self'(;|$)/)
    expect(APP_CSP).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/)
  })

  it("keeps the inert API policy on API errors and exports", async () => {
    const s = make()
    await s.addUser("admin@example.test", "admin")
    const admin = await s.signIn("admin@example.test")
    for (const path of ["/api/nothing", "/api/servers/x/versions/y/export", "/s/x/mcp"]) {
      const response = await s.request("GET", path, admin)
      expect(response.headers.get("content-security-policy"), path).toMatch(/default-src 'none'/)
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff")
    }
  })
})

describe("request limits", () => {
  it("refuses an API body over the limit", async () => {
    const s = make()
    await s.addUser("admin@example.test", "admin")
    const admin = await s.signIn("admin@example.test")
    const big = JSON.stringify({ slug: "x", name: "y".repeat(API_MAX_BODY_BYTES) })
    const response = await s.request("POST", "/api/servers", { ...admin, body: big })
    expect(response.status).toBe(413)
  })

  it("refuses an oversized body before authentication (login)", async () => {
    const s = make()
    const big = JSON.stringify({ email: "a@b.c", password: "x".repeat(API_MAX_BODY_BYTES) })
    const response = await s.request("POST", "/api/login", { body: big })
    expect(response.status).toBe(413)
  })

  it("refuses a spec over 1 MiB", async () => {
    const s = make()
    await s.addUser("admin@example.test", "admin")
    const admin = await s.signIn("admin@example.test")
    const created = await s.request("POST", "/api/servers", {
      ...admin,
      body: { slug: "big", name: "b" },
    })
    const id = (created.json.server as { id: string }).id
    const response = await s.request("POST", `/api/servers/${id}/versions`, {
      ...admin,
      body: { yaml: `# ${"x".repeat(1024 * 1024 + 1)}` },
    })
    expect(response.status).toBe(400)
  })

  it("counts every client IP across the API, the gateway and the web UI", async () => {
    const s = make()
    const ip = "198.51.100.77"
    let limited = 0
    for (let i = 0; i < 1210; i++) {
      const path = i % 3 === 0 ? "/api/setup" : i % 3 === 1 ? "/s/x/mcp" : "/"
      const response = await s.request("GET", path, { ip })
      if (response.status === 429) limited++
    }
    expect(limited).toBe(10)
    // Another client is not affected.
    expect((await s.request("GET", "/api/setup", { ip: "198.51.100.78" })).status).toBe(200)
    // 1,210 requests: slow when the whole suite runs in parallel.
  }, 30_000)
})
