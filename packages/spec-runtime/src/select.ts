import { type ChildProcess, type ForkOptions, fork } from "node:child_process"
import { existsSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { compile } from "@jmespath-community/jmespath"
import { ToolError } from "@kervan/core"
import { SPEC_LIMITS } from "./spec-schema.js"

export class SelectError extends Error {
  override name = "SelectError"
}

/**
 * Checks a JMESPath expression when the spec loads. JMESPath is an interpreted query language with
 * no code execution; Kervan registers no custom functions.
 */
export function checkSelect(expression: string): void {
  if (expression.length > SPEC_LIMITS.maxSelectLength) {
    throw new SelectError(`select is longer than ${SPEC_LIMITS.maxSelectLength} characters.`)
  }
  try {
    compile(expression)
  } catch (error) {
    throw new SelectError(`select is not a valid JMESPath expression: ${(error as Error).message}`)
  }
}

/** The selected value as JSON text: in full up to `maxChars`, and its full length. */
export interface Selected {
  length: number
  /** The JSON text, or its first `maxChars + 1` characters when it is longer. */
  text: string
}

/** Processes evaluating expressions at once; more calls wait for one of them. */
const PROCESSES = 2
/** Heap of a select process. Data and result have to fit; a runaway expression gets no more. */
const HEAP_MB = 256

/**
 * Evaluates `expression` on `data` in a separate process. A short expression can still allocate
 * gigabytes or run for minutes (JMESPath functions build data out of nothing, `map` nests and
 * `$` reaches the whole document), and evaluation is synchronous: in this process it would stall
 * every other request, and running out of memory would end the process. There, it is stopped
 * after `timeoutMs` (counted from this call, waiting included) or when it runs out of memory, and
 * the call fails with a `ToolError`.
 */
export function select(
  data: unknown,
  expression: string,
  options: { timeoutMs: number; maxChars: number; signal?: AbortSignal | undefined },
): Promise<Selected> {
  return pool.run({ data, expression, maxChars: options.maxChars }, options)
}

interface Job {
  data: unknown
  expression: string
  maxChars: number
}

interface Pending {
  job: Job
  resolve: (selected: Selected) => void
  reject: (error: Error) => void
  /** Ends the wait for this job (timer, abort listener). */
  cleanup: () => void
  settled: boolean
  /** Set when a process takes the job; its answer must carry the same id. */
  id?: number
}

interface Worker {
  child: ChildProcess
  current?: Pending | undefined
}

/** The script a select process runs: built JavaScript, or the TypeScript source in development. */
function childScript(): string {
  const built = fileURLToPath(new URL("./select-child.js", import.meta.url))
  return existsSync(built) ? built : fileURLToPath(new URL("./select-child.ts", import.meta.url))
}

/**
 * Environment variables a select process gets: none. It reads no configuration, and the parent's
 * environment holds what it must never see (Studio's master keys, tokens, `NODE_OPTIONS`).
 */
export const SELECT_ENV_ALLOWLIST: readonly string[] = []

/** Node's permission model flag: `--permission` (22.13+), `--experimental-permission` before. */
function permissionFlag(): string | undefined {
  const flags = process.allowedNodeEnvironmentFlags
  if (flags.has("--permission")) return "--permission"
  return flags.has("--experimental-permission") ? "--experimental-permission" : undefined
}

/**
 * How a select process starts (exported for tests). Under the permission model it may read only
 * its script, the package.json beside it (the module format) and the JMESPath module, which it
 * imports by path; it may not write files, start processes or workers. The network, which that
 * model leaves open in Node 22 and 24, is closed by the script itself.
 */
export function selectProcess(): {
  script: string
  args: string[]
  options: ForkOptions & { execArgv: string[]; env: Record<string, string> }
} {
  const script = childScript()
  const jmespath = realpathSync(fileURLToPath(import.meta.resolve("@jmespath-community/jmespath")))
  const manifest = fileURLToPath(new URL("../package.json", import.meta.url))
  const permission = permissionFlag()
  const env: Record<string, string> = {}
  for (const name of SELECT_ENV_ALLOWLIST) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return {
    script,
    args: [jmespath],
    options: {
      execArgv: [
        `--max-old-space-size=${HEAP_MB}`,
        ...(permission
          ? [permission, ...[script, manifest, jmespath].map((file) => `--allow-fs-read=${file}`)]
          : []),
      ],
      env,
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    },
  }
}

class SelectPool {
  readonly #workers = new Set<Worker>()
  readonly #queue: Pending[] = []
  #nextId = 1

  run(
    job: Job,
    options: { timeoutMs: number; signal?: AbortSignal | undefined },
  ): Promise<Selected> {
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        job,
        resolve,
        reject,
        cleanup: () => {},
        settled: false,
      }
      const fail = (error: Error) => {
        if (pending.settled) return
        this.#settle(pending)
        // A job still waiting leaves the queue; one running takes its process with it.
        const queued = this.#queue.indexOf(pending)
        if (queued >= 0) this.#queue.splice(queued, 1)
        for (const worker of this.#workers) {
          if (worker.current === pending) this.#discard(worker)
        }
        reject(error)
        this.#dispatch()
      }
      const timer = setTimeout(
        () =>
          fail(
            new ToolError(
              `output.select took longer than ${options.timeoutMs} ms and was stopped. Simplify the expression.`,
            ),
          ),
        options.timeoutMs,
      )
      const onAbort = () => fail(new ToolError("The call was cancelled."))
      options.signal?.addEventListener("abort", onAbort, { once: true })
      pending.cleanup = () => {
        clearTimeout(timer)
        options.signal?.removeEventListener("abort", onAbort)
      }
      if (options.signal?.aborted) return onAbort()
      this.#queue.push(pending)
      this.#dispatch()
    })
  }

  #settle(pending: Pending): void {
    pending.settled = true
    pending.cleanup()
  }

  #dispatch(): void {
    while (this.#queue.length > 0) {
      let idle = [...this.#workers].find((worker) => worker.current === undefined)
      if (!idle && this.#workers.size < PROCESSES) idle = this.#start()
      if (!idle) return
      const pending = this.#queue.shift()
      if (!pending) return
      pending.id = this.#nextId++
      idle.current = pending
      // Keep this process alive while a job runs (and only then).
      idle.child.ref()
      idle.child.channel?.ref()
      idle.child.send({ id: pending.id, ...pending.job })
    }
  }

  #start(): Worker {
    const { script, args, options } = selectProcess()
    const child = fork(script, args, options)
    const worker: Worker = { child }
    this.#workers.add(worker)
    child.on("message", (message: Reply) => this.#reply(worker, message))
    child.on("exit", () => {
      // Out of memory, or killed: the job it was running fails, the next job gets a new process.
      if (!this.#workers.delete(worker)) return
      const pending = worker.current
      worker.current = undefined
      if (pending && !pending.settled) {
        this.#settle(pending)
        pending.reject(
          new ToolError(
            "output.select needed more memory than it may use and was stopped. Simplify the expression.",
          ),
        )
      }
      this.#dispatch()
    })
    child.on("error", () => this.#discard(worker))
    return worker
  }

  #reply(worker: Worker, message: Reply): void {
    const pending = worker.current
    if (!pending || pending.id !== message.id) return
    worker.current = undefined
    this.#idle(worker)
    if (!pending.settled) {
      this.#settle(pending)
      if (message.ok) pending.resolve({ length: message.length, text: message.text })
      // An evaluation error (a function given the wrong type): as before, not a ToolError.
      else pending.reject(new SelectError(`output.select failed: ${message.error}`))
    }
    this.#dispatch()
  }

  /** An idle process does not keep this one alive. */
  #idle(worker: Worker): void {
    worker.child.unref()
    worker.child.channel?.unref()
  }

  #discard(worker: Worker): void {
    if (!this.#workers.delete(worker)) return
    worker.current = undefined
    worker.child.kill()
  }
}

type Reply =
  | { id: number; ok: true; length: number; text: string }
  | { id: number; ok: false; error: string }

const pool = new SelectPool()
