// Runs `output.select` expressions for `select.ts`, in a process of its own: an expression can
// cost far more than its length suggests (functions build strings and arrays out of nothing, and
// `map` nests), and evaluation is synchronous. Here a runaway expression only stalls or crashes
// this process, which the parent kills or replaces; the parent keeps serving.
import { type JSONValue, search } from "@jmespath-community/jmespath"

interface Task {
  id: number
  data: unknown
  expression: string
  /** Longer results are not sent back in full: only the length and this many characters. */
  maxChars: number
}

process.on("message", (task: Task) => {
  let reply: Record<string, unknown>
  try {
    const text = JSON.stringify(search(task.data as JSONValue, task.expression) ?? null)
    reply = { id: task.id, ok: true, length: text.length, text: text.slice(0, task.maxChars + 1) }
  } catch (error) {
    reply = { id: task.id, ok: false, error: (error as Error).message }
  }
  process.send?.(reply)
})

// The parent is gone (or let go of this process): nothing more will come.
process.on("disconnect", () => process.exit(0))
