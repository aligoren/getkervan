import { describe, expect, it, vi } from "vitest"
import { InMemoryToolRegistry, type KervanDefinitionError, z } from "../src/index.js"
import { sameEntries } from "../src/registry.js"

const def = (description = "d") => ({ description, handler: () => "ok" })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("InMemoryToolRegistry", () => {
  it("adds at the end, replaces in place and removes", () => {
    const registry = new InMemoryToolRegistry()
    registry.add("a", def())
    registry.add("b", def())
    registry.add("c", def())
    registry.replace("a", def("new a"))
    expect(registry.list().map((t) => t.name)).toEqual(["a", "b", "c"])
    expect(registry.list()[0]?.description).toBe("new a")
    expect(registry.remove("b")).toBe(true)
    expect(registry.remove("b")).toBe(false)
    expect(registry.has("b")).toBe(false)
    expect(registry.list().map((t) => t.name)).toEqual(["a", "c"])
  })

  it("validates definitions and rejects duplicates or unknown replacements", () => {
    const registry = new InMemoryToolRegistry()
    registry.add("a", def())
    const codeOf = (fn: () => void) => {
      try {
        fn()
      } catch (error) {
        return (error as KervanDefinitionError).code
      }
    }
    expect(codeOf(() => registry.add("a", def()))).toBe("DUPLICATE_TOOL")
    expect(codeOf(() => registry.replace("missing", def()))).toBe("UNKNOWN_TOOL")
    expect(codeOf(() => registry.add("bad name", def()))).toBe("INVALID_TOOL_NAME")
    // biome-ignore lint/suspicious/noExplicitAny: deliberately invalid input
    const input: any = z.string()
    expect(codeOf(() => registry.replace("a", { ...def(), input }))).toBe("INVALID_INPUT_SCHEMA")
    expect(registry.list()).toHaveLength(1)
  })

  it("keeps entry identity for unchanged tools", () => {
    const registry = new InMemoryToolRegistry()
    registry.add("a", def())
    registry.add("b", def())
    const before = registry.list()
    expect(registry.list()).toBe(before)
    registry.replace("b", def("changed"))
    const after = registry.list()
    expect(after).not.toBe(before)
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(Object.isFrozen(after)).toBe(true)
    expect(Object.isFrozen(after[0])).toBe(true)
  })

  it("coalesces synchronous changes into one notification", async () => {
    const registry = new InMemoryToolRegistry()
    const listener = vi.fn()
    registry.onChange(listener)
    registry.add("a", def())
    registry.add("b", def())
    registry.remove("a")
    expect(listener).not.toHaveBeenCalled()
    await tick()
    expect(listener).toHaveBeenCalledTimes(1)
    registry.add("c", def())
    await tick()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it("does not notify for no-op removals", async () => {
    const registry = new InMemoryToolRegistry()
    const listener = vi.fn()
    registry.onChange(listener)
    registry.remove("nothing")
    await tick()
    expect(listener).not.toHaveBeenCalled()
  })

  it("unsubscribes idempotently and isolates failing listeners", async () => {
    const errors: unknown[] = []
    const registry = new InMemoryToolRegistry({ onListenerError: (e) => errors.push(e) })
    const good = vi.fn()
    const off = registry.onChange(() => {
      throw new Error("boom")
    })
    registry.onChange(good)
    registry.add("a", def())
    await tick()
    expect(good).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
    off()
    off()
    registry.add("b", def())
    await tick()
    expect(errors).toHaveLength(1)
    expect(good).toHaveBeenCalledTimes(2)
  })
})

describe("sameEntries", () => {
  it("compares by identity and order", () => {
    const registry = new InMemoryToolRegistry()
    registry.add("a", def())
    registry.add("b", def())
    const [a, b] = registry.list()
    if (!a || !b) throw new Error("unreachable")
    expect(sameEntries([a, b], [a, b])).toBe(true)
    expect(sameEntries([a, b], [b, a])).toBe(false)
    expect(sameEntries([a], [a, b])).toBe(false)
    expect(sameEntries([a, b], [a, { ...b }])).toBe(false)
  })
})
