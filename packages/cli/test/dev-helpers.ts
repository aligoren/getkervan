import { type ChildProcess, spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"

export const repo = fileURLToPath(new URL("../../..", import.meta.url))
export const kervanBin = path.join(repo, "packages/cli/bin/kervan.js")
export const SECRET = "sk-test-4f8a1c2e9b7d"

/** The server under development. `{{VERSION}}` and `{{EXTRA}}` are filled per test. */
const SERVER = `import { spawn } from "node:child_process"
import { createApp, ToolError, z } from "@kervan/core"
import { serve } from "@kervan/transport/node"

const VERSION = "{{VERSION}}"
const app = createApp({ name: "fixture", version: "0.0.0" })

app.tool("version", { description: "Returns the code version", handler: () => VERSION })
app.tool("pid", { description: "Returns the server process id", handler: () => String(process.pid) })
app.tool("slow", {
  description: "Waits, then returns the code version",
  input: z.object({ ms: z.number() }),
  handler: async ({ ms }) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return VERSION
  },
})
app.tool("install_extra", {
  description: "Registers the extra tool at runtime",
  handler: () => {
    if (!app.registry.has("extra")) app.tool("extra", { description: "Added at runtime", handler: () => "extra!" })
    return "installed"
  },
})
app.tool("leak", {
  description: "Fails while handling a secret",
  handler: () => {
    console.error("connecting with " + process.env.KERVAN_TEST_API_KEY)
    throw new ToolError("auth failed for key " + process.env.KERVAN_TEST_API_KEY)
  },
})
{{EXTRA}}
if (process.env.FIXTURE_STUBBORN) {
  // Ignores stdin EOF and keeps a grandchild alive: only a forced tree kill stops it.
  setInterval(() => {}, 1000)
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
  console.error("grandchild " + grandchild.pid)
}
await serve(app)
`

export function serverSource(
  version: string,
  extra = "",
  lineEnding: "\n" | "\r\n" = "\n",
): string {
  return SERVER.replace("{{VERSION}}", version)
    .replace("{{EXTRA}}", extra)
    .replace(/\r?\n/g, lineEnding)
}

export interface Project {
  dir: string
  entry: string
  write(source: string): Promise<void>
  cleanup(): Promise<void>
}

/** A project in a temp folder whose path contains spaces, linked to this workspace's packages. */
export async function makeProject(source = serverSource("v1")): Promise<Project> {
  const parent = await mkdtemp(path.join(os.tmpdir(), "kervan dev "))
  const dir = path.join(parent, "fixture project")
  await mkdir(path.join(dir, "src"), { recursive: true })
  await writeFile(path.join(dir, "package.json"), '{ "name": "fixture", "type": "module" }\n')
  const links: Record<string, string> = {
    "@kervan/core": path.join(repo, "packages/core"),
    "@kervan/transport": path.join(repo, "packages/transport"),
  }
  for (const [name, target] of Object.entries(links)) {
    const link = path.join(dir, "node_modules", name)
    await mkdir(path.dirname(link), { recursive: true })
    await symlink(realpathSync(target), link, "junction")
  }
  const entry = path.join(dir, "src", "server.ts")
  await writeFile(entry, source)
  return {
    dir,
    entry,
    write: (content) => writeFile(entry, content),
    cleanup: () => rm(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }),
  }
}

/** Subclass so the SDK probes the protocol era in place instead of spawning a second dev host. */
class InPlaceStdioTransport extends StdioClientTransport {}

export interface DevSession {
  client: Client
  stderr: () => string
  notifications: () => number
  close(): Promise<void>
}

/** Starts `kervan dev <entry> --stdio` and connects a real client to it. */
export async function connectDev(
  project: Project,
  era: "legacy" | "modern",
  extraArgs: string[] = [],
  env: Record<string, string> = {},
): Promise<DevSession> {
  const transport = new InPlaceStdioTransport({
    command: process.execPath,
    args: [kervanBin, "dev", "src/server.ts", "--stdio", ...extraArgs],
    cwd: project.dir,
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: "pipe",
  })
  let stderr = ""
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const client = new Client(
    { name: "dev-test", version: "0.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  )
  let notifications = 0
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    notifications++
  })
  await client.connect(transport)
  if (era === "modern") await client.listen({ toolsListChanged: true })
  return {
    client,
    stderr: () => stderr,
    notifications: () => notifications,
    close: () => client.close(),
  }
}

export function textOf(result: unknown): string {
  const content = (result as { content: { type: string; text?: string }[] }).content
  return content.map((block) => block.text ?? "").join("")
}

export interface DevProcess {
  child: ChildProcess
  stdout: () => string
  stderr: () => string
  exited: Promise<number | null>
}

/** Spawns `kervan dev` with piped stdio, for HTTP mode and the REPL. */
export function spawnDev(
  project: Project,
  args: string[],
  env: Record<string, string> = {},
): DevProcess {
  const child = spawn(process.execPath, [kervanBin, "dev", "src/server.ts", ...args], {
    cwd: project.dir,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve))
  return { child, stdout: () => stdout, stderr: () => stderr, exited }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
