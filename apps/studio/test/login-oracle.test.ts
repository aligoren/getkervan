// A failed sign-in tells nobody whether the account exists: the same answer, the same work (a
// password check against a prepared dummy hash), the same audit row. Plus the email's length
// limit and the audit endpoint's headers.
import { afterEach, describe, expect, it, vi } from "vitest"
import { listAudit } from "../src/db/repos/audit.js"
import type { ApiStudio } from "./api-helpers.js"

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

async function fresh() {
  const { apiStudio } = await import("./api-helpers.js")
  const s = apiStudio({ throttle: { accountFailures: 1000, ipFailures: 1000 } })
  studios.push(s)
  return s
}

const wrong = (s: ApiStudio, email: string, ip = "198.51.100.9") =>
  s.request("POST", "/api/login", { body: { email, password: "not the password!" }, ip })

describe("the dummy password hash", () => {
  it("is prepared when the API is created, before any sign-in", async () => {
    vi.resetModules()
    const accounts = await import("../src/accounts.js")
    expect(accounts.loginTimingPrepared()).toBe(false)
    const { apiStudio } = await import("./api-helpers.js")
    const s = apiStudio()
    studios.push(s)
    expect(accounts.loginTimingPrepared()).toBe(true)
  })

  it("makes an unknown account cost as much as a known one (same order of magnitude)", async () => {
    const s = await fresh()
    await s.addUser("real@example.test", "member")
    const time = async (email: string, ip: string) => {
      const started = performance.now()
      const response = await wrong(s, email, ip)
      expect(response.status).toBe(401)
      return performance.now() - started
    }
    // The very first unknown-account attempt too: the dummy hash is ready by then.
    const firstUnknown = await time("first-ghost@example.test", "198.51.100.200")
    const known: number[] = []
    const unknown: number[] = []
    for (let i = 0; i < 5; i++) {
      known.push(await time("real@example.test", `198.51.100.${10 + i}`))
      unknown.push(await time(`ghost${i}@example.test`, `198.51.100.${30 + i}`))
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[2] ?? 0
    // Not a fixed number of milliseconds (machines differ): the two paths must be within 10x of
    // each other. Without the dummy check an unknown account answers ~100x faster.
    const ratio = (a: number, b: number) => Math.max(a, b) / Math.max(Math.min(a, b), 0.001)
    expect(ratio(median(known), median(unknown))).toBeLessThan(10)
    expect(ratio(median(known), firstUnknown)).toBeLessThan(10)
  })
})

describe("a failed sign-in", () => {
  it("gives the same audit row whether or not the account exists, except for the email", async () => {
    const s = await fresh()
    await s.addUser("real@example.test", "member")
    await wrong(s, "real@example.test")
    await wrong(s, "ghost@example.test")
    const rows = listAudit(s.database.db, s.scope, { action: "login.failure" })
    const real = rows.find((row) => row.details?.email === "real@example.test")
    const ghost = rows.find((row) => row.details?.email === "ghost@example.test")
    expect(real).toBeDefined()
    expect(ghost).toBeDefined()
    const shape = (row: typeof real) => {
      const { id: _id, at: _at, details, ...rest } = row ?? ({} as NonNullable<typeof real>)
      return { ...rest, detailKeys: Object.keys(details ?? {}) }
    }
    expect(shape(real)).toEqual(shape(ghost))
    expect(shape(real)).toEqual({
      actorType: "user",
      actorId: null,
      action: "login.failure",
      targetType: null,
      targetId: null,
      ip: "198.51.100.9",
      detailKeys: ["email"],
    })
  })

  it("records an email of up to 320 characters, and refuses a longer one without a record", async () => {
    const s = await fresh()
    const at320 = `${"a".repeat(316)}@b.c`
    const at321 = `${"a".repeat(317)}@b.c`
    expect([at320.length, at321.length]).toEqual([320, 321])
    expect((await wrong(s, at320)).status).toBe(401)
    expect((await wrong(s, at321)).status).toBe(400)
    const emails = listAudit(s.database.db, s.scope, { action: "login.failure" }).map(
      (row) => row.details?.email,
    )
    expect(emails).toEqual([at320])
  })
})

describe("the audit endpoint", () => {
  it("answers JSON with nosniff, so a browser never renders it as HTML", async () => {
    const s = await fresh()
    await s.addUser("admin@example.test", "admin")
    const admin = await s.signIn("admin@example.test")
    await wrong(s, "<img src=x onerror=alert(1)>@example.test")
    const response = await s.request("GET", "/api/audit", admin)
    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toMatch(/^application\/json(;|$)/)
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(response.text).toContain("<img src=x onerror=alert(1)>@example.test")
  })
})
