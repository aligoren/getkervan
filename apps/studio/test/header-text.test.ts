// Text that comes from request headers and is shown to people: the User-Agent in the session list
// (the only one; client IPs are checked with isIP). A browser, or anyone with a stolen password,
// chooses it; Node decodes header bytes as latin1, so it can hold C1 controls (U+0080-U+009F, for
// example U+009B, a one-byte terminal escape) and a soft hyphen. They are shown as visible escapes.
import { afterEach, describe, expect, it } from "vitest"
import { displayUserAgent } from "../src/db/repos/sessions.js"
import { type ApiStudio, apiStudio, cookieOf, PASSWORD } from "./api-helpers.js"

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

const cp = (...points: number[]) => String.fromCodePoint(...points)

describe("a User-Agent in the session list", () => {
  it("shows hidden characters as visible escapes, and doubles backslashes", async () => {
    const s = apiStudio()
    studios.push(s)
    await s.addUser("member@example.test", "member")
    const userAgent = `Mozilla/5.0 ${cp(0x9b)}31m red ${cp(0x85)}next line ${cp(0xad)}soft \\u0041 ${cp(0x7f)}`
    const login = await s.request("POST", "/api/login", {
      body: { email: "member@example.test", password: PASSWORD },
      headers: { "user-agent": userAgent },
    })
    expect(login.status).toBe(200)
    const cookie = cookieOf(login.headers)

    const listed = await s.request("GET", "/api/profile/sessions", { cookie })
    expect(listed.status).toBe(200)
    const [session] = listed.json.sessions as { userAgent: string }[]
    expect(session?.userAgent).toBe(
      "Mozilla/5.0 \\u009B31m red \\u0085next line \\u00ADsoft \\\\u0041 \\u007F",
    )
    // No hidden character reaches the page.
    expect(listed.text).not.toMatch(new RegExp(`[${cp(0x7f)}-${cp(0x9f)}${cp(0xad)}]`))
  })

  it("is cut to 200 characters after escaping, never inside an escape", () => {
    const shown = displayUserAgent(`${"a".repeat(195)}${cp(0x85)}${"b".repeat(50)}`) ?? ""
    expect(shown.length).toBeLessThanOrEqual(200)
    expect(shown).toMatch(/^a{195}…$/)
    expect(displayUserAgent(null)).toBeNull()
    expect(displayUserAgent("Mozilla/5.0 (X11; Linux x86_64)")).toBe(
      "Mozilla/5.0 (X11; Linux x86_64)",
    )
  })
})
