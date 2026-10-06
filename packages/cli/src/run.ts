import { existsSync } from "node:fs"
import path from "node:path"
import { serveHttp, serveStdio } from "@kervan/transport/node"
import { findProjectRoot, watchProject } from "./dev/watch.js"
import { cliNetworkPolicy, loadEnvFiles, SpecHost } from "./spec-host.js"

export interface RunOptions {
  spec: string
  mode: "stdio" | "http"
  port: number
  host: string
  allowedHosts: string[]
  envFiles: string[]
  watch: boolean
  allowPrivateNetwork: boolean
  /** Addresses or CIDR ranges tools may never reach (`--deny-network`). */
  denyNetwork: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  stdin: NodeJS.ReadableStream
  stdout: NodeJS.WritableStream
  stderr: NodeJS.WritableStream
}

const LOCALHOST = new Set(["127.0.0.1", "localhost", "::1"])

/** Problems that stop `kervan run` before it loads anything. */
export function runPreflight(options: RunOptions): string[] {
  const errors: string[] = []
  const file = path.resolve(options.cwd, options.spec)
  if (!existsSync(file)) errors.push(`Spec file not found: ${options.spec}`)
  if (options.allowPrivateNetwork && options.env.NODE_ENV === "production") {
    errors.push(
      "--allow-private-network lets tools reach internal addresses (cloud metadata, databases) " +
        "and is refused with NODE_ENV=production.",
    )
  }
  if (
    options.mode === "http" &&
    !LOCALHOST.has(options.host) &&
    options.allowedHosts.length === 0
  ) {
    errors.push(
      `Serving on ${options.host} needs --allowed-host <name> for every host name clients use ` +
        "(Host header validation against DNS rebinding).",
    )
  }
  return errors
}

/** Serves a kervan.yaml spec until stopped. Resolves with the exit code. */
export async function runSpec(options: RunOptions): Promise<number> {
  // On stdio, stdout is the MCP connection: every message goes to stderr.
  const print = (line: string) => options.stderr.write(`${line}\n`)
  const errors = runPreflight(options)
  if (errors.length > 0) {
    for (const error of errors) print(`Error: ${error}`)
    return 1
  }
  const file = path.resolve(options.cwd, options.spec)

  const network = cliNetworkPolicy(options)
  let host: SpecHost
  try {
    const env = await loadEnvFiles(options.envFiles, options.env, options.cwd)
    host = await SpecHost.start({
      file,
      env,
      print,
      ...(network ? { network } : {}),
    })
  } catch (error) {
    print(`Error: ${(error as Error).message}`)
    return 1
  }
  if (options.allowPrivateNetwork) {
    print("Warning: --allow-private-network is on; tools can reach internal addresses.")
  }

  const closers: (() => Promise<void>)[] = []
  if (options.watch) {
    const stop = watchProject(findProjectRoot(path.dirname(file)), (files) => {
      const name = path.basename(file)
      if (files.some((changed) => changed === "?" || path.basename(changed) === name)) {
        void host.reload("file change")
      }
    })
    closers.push(async () => stop())
  }

  if (options.mode === "http") {
    const server = await serveHttp(host.app, {
      port: options.port,
      host: options.host,
      ...(options.allowedHosts.length > 0 ? { allowedHosts: options.allowedHosts } : {}),
    })
    closers.push(() => server.close())
    print(`Serving ${host.app.name} on ${server.url.href}`)
  } else {
    const handle = serveStdio(host.app)
    closers.push(() => handle.close())
  }

  await new Promise<void>((resolve) => {
    const stop = () => resolve()
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    if (options.mode === "stdio") {
      options.stdin.once("end", stop)
      options.stdin.once("close", stop)
    }
  })
  for (const close of closers) await close().catch(() => {})
  await host.close()
  return 0
}
