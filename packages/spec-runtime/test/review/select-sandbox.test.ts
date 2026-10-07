// Security review (release): the select process gets nothing it does not need. Its environment
// is empty (Studio's master keys and NODE_OPTIONS stay in the parent), each message holds only
// redacted data and the expression, and it can neither read or write files beyond the three it
// loads, nor start processes or workers, nor use the network. The probe runs with exactly the
// options select.ts starts the process with, and loads the process's own script.
import { spawn } from "node:child_process"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { createApp, silentLogger } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { applySpec, loadSpec, type NetworkPolicy } from "../../src/index.js"
import { select, selectProcess } from "../../src/select.js"
import { startUpstream, type Upstream } from "../upstream.js"

const calls: unknown[][] = []
const forks: unknown[][] = []
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>()
  return {
    ...original,
    fork: (...args: Parameters<typeof original.fork>) => {
      forks.push(args)
      return original.fork(...args)
    },
  }
})
vi.mock("../../src/select.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/select.js")>()
  return {
    ...original,
    select: (...args: Parameters<typeof original.select>) => {
      calls.push(args)
      return original.select(...args)
    },
  }
})

/** The variables libuv copies into every child process on Windows (uv_spawn's required list). */
const WINDOWS_REQUIRED = [
  "HOMEDRIVE",
  "HOMEPATH",
  "LOGONSERVER",
  "PATH",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
]

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")

/** Runs `code` the way a select process runs, after loading the process's script. */
async function probe(code: string): Promise<Record<string, unknown>> {
  const { script, args, options } = selectProcess()
  const program = `
    await import(${JSON.stringify(pathToFileURL(script).href)})
    const report = {}
    ${code}
    console.log(JSON.stringify(report))
    process.exit(0)
  `
  const child = spawn(
    process.execPath,
    [...options.execArgv, "--input-type=module", "-e", program, "--", ...args],
    {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let out = ""
  let err = ""
  child.stdout.on("data", (chunk: Buffer) => {
    out += chunk.toString()
  })
  child.stderr.on("data", (chunk: Buffer) => {
    err += chunk.toString()
  })
  await new Promise((resolve) => child.on("exit", resolve))
  const line = out.trim().split("\n").at(-1)
  if (!line) throw new Error(`no report: ${err}`)
  return JSON.parse(line) as Record<string, unknown>
}

// First in this file, so the pool starts its first process here.
describe("the select pool", () => {
  it("starts its processes with exactly the options checked below", async () => {
    expect((await select({ a: 1 }, "a", { timeoutMs: 10_000, maxChars: 100 })).text).toBe("1")
    const { script, args, options } = selectProcess()
    expect(forks).toEqual([[script, args, options]])
  }, 20_000)
})

describe("the select process", () => {
  it("gets an empty environment: no KERVAN_ value, no NODE_OPTIONS", async () => {
    const saved = { ...process.env }
    process.env.KERVAN_STUDIO_MASTER_KEY = "1:test-only-not-a-real-key"
    process.env.KERVAN_STUDIO_PREVIOUS_MASTER_KEYS = "0:test-only-not-a-real-key"
    process.env.KERVAN_TOKEN = "test-only"
    process.env.NODE_OPTIONS = "--no-warnings"
    try {
      expect(selectProcess().options.env).toEqual({})
      const report = await probe("report.env = Object.keys(process.env)")
      const names = report.env as string[]
      expect(names.filter((name) => /^(KERVAN_|NODE_)/i.test(name))).toEqual([])
      // On Windows, libuv always passes a few system variables (it needs them to start a
      // process); nothing else gets through.
      const system = process.platform === "win32" ? WINDOWS_REQUIRED : []
      expect(names.filter((name) => !system.includes(name.toUpperCase()))).toEqual([])
    } finally {
      for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name]
    }
  }, 20_000)

  it("cannot read or write files, start processes or workers, or use the network", async () => {
    const report = await probe(`
      const fs = await import("node:fs")
      const tryIt = (name, run) => { try { run(); report[name] = "allowed" } catch (error) { report[name] = error.code ?? error.message } }
      tryIt("read", () => fs.readFileSync(${JSON.stringify(path.join(repo, "package.json"))}))
      tryIt("write", () => fs.writeFileSync(${JSON.stringify(path.join(os.tmpdir(), "kervan-select-probe.txt"))}, "x"))
      const { spawnSync } = await import("node:child_process")
      tryIt("spawn", () => spawnSync(process.execPath, ["-v"]))
      const { Worker } = await import("node:worker_threads")
      tryIt("worker", () => new Worker("1", { eval: true }))
      const net = await import("node:net")
      tryIt("net", () => net.connect(80, "127.0.0.1"))
      const dgram = await import("node:dgram")
      tryIt("udp", () => dgram.createSocket("udp4").send("x", 53, "127.0.0.1"))
      try { await fetch("http://127.0.0.1:80/"); report.fetch = "allowed" } catch (error) { report.fetch = String(error.cause?.message ?? error.message) }
    `)
    expect(report).toEqual({
      read: "ERR_ACCESS_DENIED",
      write: "ERR_ACCESS_DENIED",
      spawn: "ERR_ACCESS_DENIED",
      worker: "ERR_ACCESS_DENIED",
      net: "A select process does not use the network.",
      udp: "A select process does not use the network.",
      fetch: "A select process does not use the network.",
    })
  }, 20_000)
})

describe("what the select process is given", () => {
  let upstream: Upstream
  beforeAll(async () => {
    upstream = await startUpstream()
  })
  afterAll(() => upstream.close())

  it("is the redacted data and the expression, never a secret", async () => {
    const secret = "sk-select-sandbox-0123456789"
    const port = new URL(upstream.url).port
    const network: NetworkPolicy = {
      allowPrivate: ["127.0.0.1/32"],
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
    }
    const loaded = await loadSpec(
      `specVersion: 1
name: sandbox
version: 0.0.0
secrets: [{ name: API_KEY, hosts: ['bound.test:${port}'] }]
defaults: { http: { allowInsecureHttp: true, timeoutMs: 2000 } }
tools:
  - name: call
    description: Sends the key to the bound host
    http:
      url: http://bound.test:${port}/reflect-escaped
      headers: { X-Key: "{{secrets.API_KEY}}" }
    output: { select: "@" }
`,
      {
        secrets: { get: (name) => (name === "API_KEY" ? secret : undefined) },
        network,
        allowSecretsOverHttp: true,
      },
    )
    const app = createApp({ name: "sandbox", version: "0.0.0", logger: silentLogger })
    applySpec(app.registry, loaded)
    const client = await createTestClient(app)
    try {
      calls.length = 0
      await client.callTool({ name: "call", arguments: {} })
      expect(calls).toHaveLength(1)
      const [data, expression, options] = calls[0] ?? []
      expect(expression).toBe("@")
      expect(JSON.stringify(data)).toContain("[redacted]")
      expect(JSON.stringify(calls)).not.toContain(secret)
      expect(Object.keys(options as object).sort()).toEqual(["maxChars", "signal", "timeoutMs"])
    } finally {
      await client.close()
    }
  })
})
