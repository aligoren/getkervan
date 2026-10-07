// Runs `output.select` expressions for `select.ts`, in a process of its own: an expression can
// cost far more than its length suggests (functions build strings and arrays out of nothing, and
// `map` nests), and evaluation is synchronous. Here a runaway expression only stalls or crashes
// this process, which the parent kills or replaces; the parent keeps serving.
//
// The process gets nothing it does not need (see `selectProcess` in select.ts): an empty
// environment, only the data and the expression in each message, and, under Node's permission
// model, no file system beyond the three files it loads, no child processes and no workers. The
// permission model of Node 22 and 24 does not cover the network, so this file closes it itself.
import dgram from "node:dgram"
import { syncBuiltinESMExports } from "node:module"
import net from "node:net"
import { pathToFileURL } from "node:url"
import type { JSONValue, search as Search } from "@jmespath-community/jmespath"

const noNetwork = (): never => {
  throw new Error("A select process does not use the network.")
}
// TCP (and with it TLS, HTTP and fetch) connects through net.Socket. A UDP socket must be bound
// before it sends (send binds it first), and binding or connecting it fails here.
net.Socket.prototype.connect = noNetwork
dgram.Socket.prototype.bind = noNetwork
dgram.Socket.prototype.connect = noNetwork
syncBuiltinESMExports()

interface Task {
  id: number
  data: unknown
  expression: string
  /** Longer results are not sent back in full: only the length and this many characters. */
  maxChars: number
}

// The JMESPath module, by the path the parent resolved (its last argument): nothing is looked up.
const loading: Promise<{ search: typeof Search }> = import(
  pathToFileURL(process.argv.at(-1) ?? "").href
)
loading.catch(() => process.exit(1))

// Listening at once: a task that arrives while the module loads waits for it.
process.on("message", async (task: Task) => {
  let reply: Record<string, unknown>
  try {
    const { search } = await loading
    const text = JSON.stringify(search(task.data as JSONValue, task.expression) ?? null)
    reply = { id: task.id, ok: true, length: text.length, text: text.slice(0, task.maxChars + 1) }
  } catch (error) {
    reply = { id: task.id, ok: false, error: (error as Error).message }
  }
  process.send?.(reply)
})

// The parent is gone (or let go of this process): nothing more will come.
process.on("disconnect", () => process.exit(0))
