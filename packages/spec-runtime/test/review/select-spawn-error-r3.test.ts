// Security review 3: the select pool when a select process cannot be started.
//
// When spawning fails at run time (EAGAIN: the user's process limit is reached; EMFILE: no file
// descriptors left; EACCES), Node emits only an 'error' event on the ChildProcess, never 'exit'
// (internal/child_process.js: onErrorNT). The pool's 'error' handler discards the worker, and the
// 'exit' handler, which is what fails the running job, then returns early because the worker is
// already gone. So the job that was handed to the process is never answered: it waits for its own
// timeout (the tool's whole `timeoutMs`) and then reports "took longer than ... ms", an error
// that blames the expression. Under resource exhaustion every select call behaves like that.
//
// The fake process below behaves like Node's ChildProcess after a failed spawn.
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"

let forks = 0
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>()
  return {
    ...original,
    fork: () => {
      forks++
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>
      Object.assign(child, {
        pid: undefined,
        connected: false,
        channel: undefined,
        ref: () => {},
        unref: () => {},
        kill: () => false,
        // A channel that never connected: sending fails asynchronously, with another 'error'.
        send: () => {
          process.nextTick(() =>
            child.emit(
              "error",
              Object.assign(new Error("channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" }),
            ),
          )
          return false
        },
      })
      process.nextTick(() =>
        child.emit(
          "error",
          Object.assign(new Error("spawn EAGAIN"), { code: "EAGAIN", errno: -11 }),
        ),
      )
      return child
    },
  }
})

const { select } = await import("../../src/select.js")

describe("a select process that cannot be started", () => {
  it("fails the call at once instead of holding it until the tool's timeout", async () => {
    const started = Date.now()
    const outcome = await select({ a: 1 }, "a", { timeoutMs: 4_000, maxChars: 100 }).then(
      () => "resolved",
      (error: Error) => error.message,
    )
    const waited = Date.now() - started
    expect(forks).toBeGreaterThan(0)
    // The call fails (it cannot succeed), and it says so quickly, not after the full timeout.
    expect(outcome).not.toBe("resolved")
    expect(waited).toBeLessThan(1_000)
  }, 10_000)
})
