import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { rateLimiter } from "../src/rate-limit.js"

function setup() {
  const limiter = rateLimiter({
    windowMs: 1_000,
    max: 2,
    keyGenerator: (c) => c.req.header("x-key") ?? "",
  })
  const app = new Hono()
  app.use("*", limiter)
  app.all("*", (c) => c.text("ok"))
  const hit = async (key: string) =>
    (await app.request("/", { method: "POST", headers: { "x-key": key } })).status
  return { limiter, hit }
}

beforeEach(() => {
  vi.useFakeTimers({ now: 0 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("rateLimiter", () => {
  it("resets a key's count after its window", async () => {
    const { hit } = setup()
    expect([await hit("a"), await hit("a"), await hit("a")]).toEqual([200, 200, 429])
    vi.setSystemTime(1_000)
    expect(await hit("a")).toBe(200)
  })

  it("sweeps expired keys so memory does not grow with distinct clients", async () => {
    const { limiter, hit } = setup()
    for (let i = 0; i < 100; i++) await hit(`client-${i}`)
    expect(limiter.size()).toBe(100)

    // Still inside the window: nothing is expired, nothing is removed.
    vi.setSystemTime(999)
    await hit("late")
    expect(limiter.size()).toBe(101)

    // One request after the window drops every expired key.
    vi.setSystemTime(1_000)
    await hit("fresh")
    expect(limiter.size()).toBe(2) // "late" (expires at 1999) and "fresh"

    vi.setSystemTime(2_000)
    await hit("fresh")
    expect(limiter.size()).toBe(1)
  })

  it("sweeps at most once per window", async () => {
    const { limiter, hit } = setup()
    await hit("a") // sweep at t=0, next sweep at t=1000
    vi.setSystemTime(500)
    await hit("b") // expires at 1500
    vi.setSystemTime(1_600)
    await hit("c") // sweep: a and b are expired
    expect(limiter.size()).toBe(1)
  })
})
