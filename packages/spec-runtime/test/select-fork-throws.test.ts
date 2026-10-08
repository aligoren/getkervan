// `fork` can throw at once (some errnos are reported synchronously). The pool then fails the call
// at once, never leaves it waiting for its timeout, and never throws out of an event listener.
import { describe, expect, it, vi } from "vitest"

let forks = 0
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>()
  return {
    ...original,
    fork: () => {
      forks++
      throw Object.assign(new Error("spawn EMFILE"), { code: "EMFILE" })
    },
  }
})

const { select } = await import("../src/select.js")

describe("a select process that cannot even be forked", () => {
  it("fails each call at once with a clear error", async () => {
    const started = Date.now()
    const outcomes = await Promise.all(
      [1, 2, 3].map((n) =>
        select({ a: n }, "a", { timeoutMs: 5_000, maxChars: 100 }).then(
          () => "resolved",
          (error: Error) => error.message,
        ),
      ),
    )
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(outcomes).toEqual(
      Array(3).fill("output.select could not run: its process did not start. Try again later."),
    )
    expect(forks).toBeGreaterThanOrEqual(3)
  })
})
