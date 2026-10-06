import { existsSync } from "node:fs"
import path from "node:path"
import { serveHttp, serveStdio } from "@kervan/transport/node"
import {
  currentRuntime,
  type RuntimeInfo,
  typeStrippingProblem,
  windowsLibuvWarning,
} from "../node-version.js"
import { DevHost } from "./host.js"
import { collectSecrets, createRedactor } from "./redact.js"
import { startRepl } from "./repl.js"
import { findProjectRoot, watchProject } from "./watch.js"

export interface DevOptions {
  entry: string
  /** `"http"` serves on 127.0.0.1 (with Host/Origin checks); `"stdio"` serves on stdin/stdout. */
  mode: "http" | "stdio"
  port: number
  drainTimeoutMs: number
  repl: boolean
  watch: boolean
  cwd: string
  env: NodeJS.ProcessEnv
  runtime: RuntimeInfo
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

/** Problems that stop `kervan dev` before it starts, and warnings it prints. */
export function devPreflight(options: Pick<DevOptions, "entry" | "env" | "runtime">): {
  errors: string[]
  warnings: string[]
} {
  const errors: string[] = []
  const warnings: string[] = []
  if (options.env.NODE_ENV === "production") {
    errors.push(
      "kervan dev is a development server (it watches files and restarts your code); it refuses " +
        "to run with NODE_ENV=production. Use `node <entry>` or your build output in production.",
    )
  }
  if (!existsSync(options.entry)) errors.push(`Entry file not found: ${options.entry}`)
  if (/\.[cm]?tsx?$/.test(options.entry)) {
    const problem = typeStrippingProblem(options.runtime)
    if (problem) errors.push(problem)
  }
  const warning = windowsLibuvWarning(options.runtime)
  if (warning) warnings.push(warning)
  return { errors, warnings }
}

/** Runs the dev server until it is stopped. Resolves with the exit code. */
export async function runDev(options: DevOptions): Promise<number> {
  const entry = path.resolve(options.cwd, options.entry)
  // In stdio mode stdout is the MCP connection, so every message goes to stderr.
  const log = options.mode === "stdio" ? options.stderr : options.stdout
  const print = (line: string) => log.write(`${line}\n`)
  const warn = (line: string) => options.stderr.write(`${line}\n`)

  const { errors, warnings } = devPreflight({ entry, env: options.env, runtime: options.runtime })
  for (const warning of warnings) warn(`Warning: ${warning}`)
  if (errors.length > 0) {
    for (const error of errors) warn(`Error: ${error}`)
    return 1
  }

  const root = findProjectRoot(path.dirname(entry))
  const redact = createRedactor(collectSecrets(options.env))
  const host = new DevHost({
    entry,
    cwd: root,
    env: {
      ...options.env,
      KERVAN_TRANSPORT: "stdio",
      NODE_ENV: options.env.NODE_ENV ?? "development",
    },
    drainTimeoutMs: options.drainTimeoutMs,
    redact,
    print,
  })
  await host.reload("start")

  const stopWatching = options.watch
    ? watchProject(root, (files) => {
        print(`Change detected: ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", ..." : ""}`)
        void host.reload("file change")
      })
    : () => {}

  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve
  })
  const closers: (() => Promise<void>)[] = []
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    stopWatching()
    void (async () => {
      for (const close of closers) await close().catch(() => {})
      await host.close()
      resolveDone()
    })()
  }

  if (options.mode === "stdio") {
    const handle = serveStdio(host.app)
    closers.push(() => handle.close())
    // The client closing stdin ends the session.
    options.stdin.once("end", stop)
    options.stdin.once("close", stop)
  } else {
    // Always localhost with Host/Origin validation: the dev server runs your tools.
    const server = await serveHttp(host.app, { port: options.port, host: "127.0.0.1" })
    closers.push(() => server.close())
    print(`Kervan dev server: ${server.url.href}`)
    if (options.repl) {
      const repl = await startRepl({
        app: host.app,
        input: options.stdin,
        output: options.stdout,
        redact,
        reload: () => host.reload("manual"),
        onExit: stop,
      })
      closers.unshift(() => repl.close())
    }
  }
  process.once("SIGINT", stop)

  await done
  process.removeListener("SIGINT", stop)
  return 0
}

export function defaultDevOptions(entry: string): DevOptions {
  return {
    entry,
    mode: process.stdin.isTTY ? "http" : "stdio",
    port: 3000,
    drainTimeoutMs: 10_000,
    repl: process.stdin.isTTY === true,
    watch: true,
    cwd: process.cwd(),
    env: process.env,
    runtime: currentRuntime(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  }
}
