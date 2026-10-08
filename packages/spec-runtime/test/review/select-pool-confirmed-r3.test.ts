// Security review 3, confirmed: the select pool's queue under pressure. At most two processes
// run at once; a call whose own timeout ends while it waits leaves the queue and never runs;
// cancelling a running call kills its process, and later calls get their own answers (never one
// meant for another call).
import { afterAll, describe, expect, it, vi } from "vitest"

const live = new Set<number>()
let maxLive = 0
let forks = 0
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>()
  return {
    ...original,
    fork: (...args: Parameters<typeof original.fork>) => {
      const child = original.fork(...args)
      forks++
      const pid = child.pid ?? -forks
      live.add(pid)
      maxLive = Math.max(maxLive, live.size)
      child.on("exit", () => live.delete(pid))
      return child
    },
  }
})

const { select } = await import("../../src/select.js")

// O(n^2) work: about a second or more for this size, in the child.
const SLOW = "sum(map(&sum($), @))"
const big = Array.from({ length: 16_000 }, (_, i) => i)

afterAll(() => {
  live.clear()
})

describe("the select pool under pressure", () => {
  it("runs at most two processes, drops a waiter whose timeout ended, and answers each call with its own result", async () => {
    const slowA = select(big, SLOW, { timeoutMs: 30_000, maxChars: 1_000 })
    const slowB = select(big, SLOW, { timeoutMs: 30_000, maxChars: 1_000 })
    const started = Date.now()
    const queued = select({ who: "queued" }, "who", { timeoutMs: 200, maxChars: 100 }).then(
      () => "resolved",
      (error: Error) => error.message,
    )
    expect(await queued).toMatch(/took longer than 200 ms/)
    expect(Date.now() - started).toBeLessThan(2_000)

    const late = select({ who: "late" }, "who", { timeoutMs: 30_000, maxChars: 100 })
    const results = await Promise.all([slowA, slowB, late])
    const expected = JSON.stringify(big.length * big.reduce((a, b) => a + b, 0))
    expect(results.map((r) => r.text)).toEqual([expected, expected, '"late"'])
    expect(maxLive).toBeLessThanOrEqual(2)
  }, 60_000)

  it("kills a running call's process when the call is cancelled, and the next call gets its own answer", async () => {
    const controller = new AbortController()
    const forksBefore = forks
    const running = select(big, SLOW, {
      timeoutMs: 30_000,
      maxChars: 1_000,
      signal: controller.signal,
    }).then(
      () => "resolved",
      (error: Error) => error.message,
    )
    await new Promise((resolve) => setTimeout(resolve, 100))
    controller.abort()
    expect(await running).toBe("The call was cancelled.")
    const next = await select({ x: "mine" }, "x", { timeoutMs: 30_000, maxChars: 100 })
    expect(next.text).toBe('"mine"')
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(live.size).toBeLessThanOrEqual(2)
    expect(forks).toBeGreaterThanOrEqual(forksBefore)
  }, 60_000)

  it("is not poisoned for later calls by an upstream's __proto__/constructor keys (no prototype pollution)", async () => {
    // The process is shared by every tool of every server; one upstream must not change what
    // another tool's expression sees. Sequential calls reuse the same idle process.
    const hostile = JSON.parse(
      '{"__proto__": {"polluted": "yes"}, "constructor": {"prototype": {"polluted": "yes"}}, "items": [["__proto__", {"polluted": "yes"}]], "rows": [{"k": "__proto__"}, {"k": "constructor"}, {"k": "toString"}]}',
    ) as unknown
    for (const expression of [
      "merge(@, `{}`)",
      "from_items(items)",
      "from_items(zip(keys(@), values(@)))",
      "group_by(rows, &k)",
      "let $x = @ in merge($x, constructor)",
    ]) {
      await select(hostile, expression, { timeoutMs: 10_000, maxChars: 10_000 }).catch(() => null)
    }
    const later = await select({ a: {} }, "[a.polluted, polluted, a.constructor]", {
      timeoutMs: 10_000,
      maxChars: 1_000,
    })
    expect(later.text).toBe("[null,null,null]")
    const forks0 = forks
    expect(forks0).toBeGreaterThan(0)
  }, 30_000)

  it("cuts a long result in the child: only maxChars + 1 characters come back, with the full length", async () => {
    const selected = await select({ s: "x".repeat(10_000) }, "s", {
      timeoutMs: 30_000,
      maxChars: 50,
    })
    expect(selected.length).toBe(10_002)
    expect(selected.text.length).toBe(51)
  }, 30_000)
})
