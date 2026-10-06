import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process"
import { type ToolContext, ToolError } from "@kervan/core"
import { type CallToolResult, Client, type Tool } from "@modelcontextprotocol/client"
import { ChildProcessTransport } from "./child-transport.js"

export interface ChildOptions {
  /** Path of the server's entry file, run with `node <entry>`. */
  entry: string
  cwd: string
  env: NodeJS.ProcessEnv
  /** Each line the server writes to stderr. */
  onStderr: (line: string) => void
  /** The server announced a new tool list (its own `list_changed`). */
  onToolsChanged: (tools: Tool[]) => void
  onError: (error: Error) => void
  /** How long the server may take to start and answer `tools/list`. Default: 15 s. */
  startTimeoutMs?: number
}

export type StopMethod = "graceful" | "forced"

/** Longest a proxied call may run; the server's own timeouts normally end calls much earlier. */
const CALL_TIMEOUT_MS = 10 * 60_000

/**
 * One run of the user's server in a child process, connected over stdio. Shutdown never relies on
 * signals: stdin is closed (a stdio MCP server exits on EOF), and only if the process is still
 * alive after a timeout is it killed, with `taskkill /T /F` on Windows so its whole tree goes too.
 */
export class ChildServer {
  readonly pid: number
  tools: Tool[] = []

  readonly #process: ChildProcessWithoutNullStreams
  readonly #client: Client
  readonly #exited: Promise<number | null>
  #inflight = 0
  #idle: (() => void) | undefined
  #stopping = false

  private constructor(process: ChildProcessWithoutNullStreams, client: Client) {
    this.#process = process
    this.#client = client
    this.pid = process.pid ?? -1
    this.#exited = new Promise((resolve) => {
      if (process.exitCode !== null) resolve(process.exitCode)
      else process.once("exit", (code) => resolve(code))
    })
  }

  static async start(options: ChildOptions): Promise<ChildServer> {
    const child = spawn(process.execPath, [options.entry], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    forwardLines(child.stderr, options.onStderr)
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve)
      child.once("error", reject)
    })
    await spawned

    let server: ChildServer | undefined
    const client = new Client(
      { name: "kervan-dev", version: "0.0.0" },
      {
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (error) options.onError(error)
              else if (tools && server) {
                server.tools = tools
                options.onToolsChanged(tools)
              }
            },
          },
        },
      },
    )
    server = new ChildServer(child, client)
    const transport = new ChildProcessTransport(child)
    transport.onerror = options.onError

    try {
      const exitedEarly = server.#exited.then((code) => {
        throw new Error(`The server exited with code ${code} before it was ready.`)
      })
      const timeoutMs = options.startTimeoutMs ?? 15_000
      const timedOut = sleep(timeoutMs).then(() => {
        throw new Error(`The server did not start within ${timeoutMs} ms.`)
      })
      const ready = (async () => {
        await client.connect(transport)
        return listAllTools(client)
      })()
      server.tools = await Promise.race([ready, exitedEarly, timedOut])
      exitedEarly.catch(() => {})
      return server
    } catch (error) {
      await server.stop(0)
      throw error
    }
  }

  /** Calls a tool on this server, counting it so a reload can wait for it to finish. */
  async call(name: string, args: unknown, ctx: ToolContext): Promise<CallToolResult> {
    this.#inflight++
    try {
      return (await this.#client.callTool(
        { name, arguments: args as Record<string, unknown> },
        {
          signal: ctx.signal,
          timeout: CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          onprogress: (progress) => {
            ctx.progress(progress.progress, progress.total, progress.message).catch(() => {})
          },
        },
      )) as CallToolResult
    } catch (error) {
      if (this.#stopping) {
        throw new ToolError(
          `Tool "${name}" was interrupted because the server reloaded before the call finished.`,
        )
      }
      throw error
    } finally {
      this.#inflight--
      if (this.#inflight === 0) this.#idle?.()
    }
  }

  get inflight(): number {
    return this.#inflight
  }

  /**
   * Waits up to `drainMs` for in-flight calls, then stops the process. Calls still running at that
   * point fail with a "reloaded before the call finished" tool error.
   */
  async retire(drainMs: number, exitMs = 2_000): Promise<StopMethod> {
    if (this.#inflight > 0) {
      const idle = new Promise<void>((resolve) => {
        this.#idle = resolve
      })
      await Promise.race([idle, sleep(drainMs)])
    }
    return this.stop(exitMs)
  }

  /** Closes stdin (and the MCP connection) and waits `exitMs`; then kills the process tree. */
  async stop(exitMs = 2_000): Promise<StopMethod> {
    this.#stopping = true
    await this.#client.close().catch(() => {})
    const exited = await Promise.race([
      this.#exited.then(() => true),
      sleep(exitMs).then(() => false),
    ])
    if (exited) return "graceful"
    killTree(this.#process)
    await Promise.race([this.#exited, sleep(5_000)])
    return "forced"
  }

  /** Resolves with the exit code once the process has exited. */
  get exited(): Promise<number | null> {
    return this.#exited
  }
}

async function listAllTools(client: Client): Promise<Tool[]> {
  const tools: Tool[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor })
    tools.push(...page.tools)
    cursor = page.nextCursor
  } while (cursor)
  return tools
}

/** Kills a process and its children. Windows has no process groups, so ask taskkill for /T. */
export function killTree(child: {
  pid?: number | undefined
  kill(signal?: NodeJS.Signals): boolean
}) {
  if (child.pid === undefined) return
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    })
  } else {
    child.kill("SIGKILL")
  }
}

function forwardLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void) {
  let pending = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    pending += chunk
    const lines = pending.split(/\r?\n/)
    pending = lines.pop() ?? ""
    for (const line of lines) onLine(line)
  })
  stream.on("end", () => {
    if (pending) onLine(pending)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref())
}
