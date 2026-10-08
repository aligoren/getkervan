// The select pool trusts nothing a select process sends back but a well-formed reply to the job
// it runs, within the job's size limit. A process here is a fake that answers with garbage.
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"

const replies: unknown[] = []
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>()
  return {
    ...original,
    fork: () => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>
      Object.assign(child, {
        pid: 1,
        connected: true,
        channel: { ref: () => {}, unref: () => {} },
        ref: () => {},
        unref: () => {},
        kill: () => true,
        send: (job: { id: number }) => {
          for (const reply of replies) {
            const message = typeof reply === "function" ? reply(job.id) : reply
            process.nextTick(() => child.emit("message", message))
          }
          return true
        },
      })
      return child
    },
  }
})

const { select } = await import("../src/select.js")

describe("replies from a select process", () => {
  it("are ignored unless well formed and within the size limit", async () => {
    replies.splice(
      0,
      replies.length,
      null,
      "text",
      42,
      { ok: true, text: "{}", length: 2 },
      (id: number) => ({ id, ok: true, text: "x".repeat(200), length: 200 }),
      (id: number) => ({ id, ok: true, text: 7, length: 1 }),
      (id: number) => ({ id: id + 1, ok: true, text: "1", length: 1 }),
      (id: number) => ({ id, ok: false, error: 5 }),
    )
    const outcome = await select({ a: 1 }, "a", { timeoutMs: 500, maxChars: 100 }).then(
      (selected) => `resolved ${JSON.stringify(selected)}`,
      (error: Error) => error.message,
    )
    expect(outcome).toMatch(/took longer than 500 ms/)
  })

  it("answer the call when they are", async () => {
    replies.splice(0, replies.length, null, (id: number) => ({
      id,
      ok: true,
      text: "1",
      length: 1,
    }))
    await expect(select({ a: 1 }, "a", { timeoutMs: 2_000, maxChars: 100 })).resolves.toEqual({
      length: 1,
      text: "1",
    })
  })
})
