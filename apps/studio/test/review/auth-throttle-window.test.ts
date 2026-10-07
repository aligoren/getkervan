// Security review (release): 5 failures for an account within 15 minutes lock it (T7), in any 15
// minutes: the window slides, so a burst across what a fixed window's boundary would be does not
// get twice the limit.
import { describe, expect, it } from "vitest"
import { LoginThrottle } from "../../src/api/throttle.js"

const WINDOW = 15 * 60 * 1000

describe("the account lock", () => {
  it("lets no more than 5 failed guesses through within any 15 minutes", () => {
    let now = 0
    const throttle = new LoginThrottle({ clock: () => now })
    const allowedAt: number[] = []
    const guess = (ip: string) => {
      const attempt = throttle.login("admin@example.test", ip)
      if ("retryAfter" in attempt) return
      allowedAt.push(now)
      attempt.done(false)
    }

    // One guess opens the window; three more just before it ends (4 so far, no lock yet).
    guess("203.0.113.10")
    now = WINDOW - 1000
    for (let i = 0; i < 3; i++) guess(`203.0.113.${11 + i}`)
    // One second later the window has rolled over and the count starts again.
    now = WINDOW
    for (let i = 0; i < 10; i++) guess(`203.0.113.${20 + i}`)

    const inLastSecond = allowedAt.filter((t) => t >= WINDOW - 1000).length
    const inWindow = allowedAt.filter((t) => t >= 0 && t <= WINDOW).length
    expect(inLastSecond).toBeLessThanOrEqual(5)
    expect(inWindow).toBeLessThanOrEqual(5)
  })

  it("adds no counters for attempts it refuses (a locked IP trying new names)", () => {
    const throttle = new LoginThrottle({ clock: () => 0, ipFailures: 3 })
    for (let i = 0; i < 3; i++) {
      const attempt = throttle.login(`guess${i}@example.test`, "203.0.113.50")
      if ("done" in attempt) attempt.done(false)
    }
    const size = throttle.size
    for (let i = 0; i < 1_000; i++) {
      expect(throttle.login(`new${i}@example.test`, "203.0.113.50")).toHaveProperty("retryAfter")
    }
    expect(throttle.size).toBe(size)
  })
})
