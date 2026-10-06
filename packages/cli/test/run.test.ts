import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import os from "node:os"
import path from "node:path"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createProject } from "../src/create.js"
import { kervanBin, repo, spawnDev, textOf } from "./dev-helpers.js"

const SECRET = "env-file-secret-7d2c9a41"
const POLL = { timeout: 15_000, interval: 50 }

let api: Server
let apiUrl = ""
const seenKeys: string[] = []
beforeAll(async () => {
  api = createServer((req, res) => {
    const key = String(req.headers["x-key"] ?? "")
    seenKeys.push(key)
    res.writeHead(req.url?.startsWith("/fail") ? 401 : 200, { "content-type": "application/json" })
    res.end(JSON.stringify({ greeting: "hello", path: req.url, echoedKey: key }))
  })
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve))
  apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => api.close(() => resolve())))

const dirs: string[] = []
const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close().catch(() => {})))
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })),
  )
})

function specText(description = "Says hello") {
  return `specVersion: 1
name: run-test
version: 0.0.1
secrets: [TEST_API_KEY]
defaults: { http: { allowInsecureHttp: true, timeoutMs: 3000 } }
tools:
  - name: hello
    description: ${description}
    http: { url: "${apiUrl}/hello", headers: { X-Key: "{{secrets.TEST_API_KEY}}" } }
    output: { select: "{greeting: greeting, echoedKey: echoedKey}" }
  - name: fails
    description: Upstream rejects the key
    http: { url: "${apiUrl}/fail", headers: { X-Key: "{{secrets.TEST_API_KEY}}" } }
    output: { select: "@" }
`
}

async function workspace(spec = specText(), envFile = `TEST_API_KEY=${SECRET}\n`) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kervan run "))
  dirs.push(dir)
  await writeFile(path.join(dir, "kervan.yaml"), spec)
  await writeFile(path.join(dir, ".env"), envFile)
  return dir
}

class InPlaceStdioTransport extends StdioClientTransport {}

async function connect(dir: string, args: string[], era: "legacy" | "modern" = "legacy", env = {}) {
  const transport = new InPlaceStdioTransport({
    command: process.execPath,
    args: [kervanBin, ...args],
    cwd: dir,
    env: { ...(process.env as Record<string, string>), ...env },
    stderr: "pipe",
  })
  let stderr = ""
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const client = new Client(
    { name: "run-test", version: "0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
  )
  let notifications = 0
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    notifications++
  })
  await client.connect(transport)
  if (era === "modern") await client.listen({ toolsListChanged: true })
  clients.push(client)
  return { client, stderr: () => stderr, notifications: () => notifications }
}

// The test API is local http: it needs both development flags.
const devFlags = ["--allow-private-network", "--allow-insecure-secrets"]
const runArgs = ["run", "kervan.yaml", "--env-file", ".env", ...devFlags]

describe.each(["legacy", "modern"] as const)("kervan run (stdio, %s era)", (era) => {
  it("serves spec tools with secrets from --env-file", { timeout: 30_000 }, async () => {
    const dir = await workspace()
    const { client, stderr } = await connect(dir, runArgs, era)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["hello", "fails"])
    const result = await client.callTool({ name: "hello", arguments: {} })
    expect(JSON.parse(textOf(result))).toEqual({ greeting: "hello", echoedKey: "[redacted]" })
    expect(seenKeys.at(-1)).toBe(SECRET)
    expect(stderr()).toMatch(/Loaded run-test 0\.0\.1: 2 tool/)
    expect(stderr()).not.toContain(SECRET)
  })
})

describe("kervan run", () => {
  it("blocks private addresses unless --allow-private-network is given", {
    timeout: 30_000,
  }, async () => {
    const dir = await workspace()
    const { client } = await connect(dir, [
      "run",
      "kervan.yaml",
      "--env-file",
      ".env",
      "--allow-insecure-secrets",
    ])
    const result = await client.callTool({ name: "hello", arguments: {} })
    expect(textOf(result)).toMatch(
      /was blocked: it resolves to a disallowed address \((loopback address|address of this machine)\)/,
    )
  })

  it("lets --deny-network win over --allow-private-network", { timeout: 30_000 }, async () => {
    const dir = await workspace()
    const { client } = await connect(dir, [...runArgs, "--deny-network", "127.0.0.1"])
    const result = await client.callTool({ name: "hello", arguments: {} })
    expect(textOf(result)).toMatch(
      /was blocked: it resolves to a disallowed address \(address on the deny list\)/,
    )
  })

  it("never prints the secret on errors", { timeout: 30_000 }, async () => {
    const dir = await workspace()
    const { client, stderr } = await connect(dir, runArgs)
    const result = await client.callTool({ name: "fails", arguments: {} })
    expect(textOf(result)).toBe("Upstream returned 401 Unauthorized.")
    expect(stderr()).not.toContain(SECRET)
  })

  it("lets already-set environment variables win over --env-file", {
    timeout: 30_000,
  }, async () => {
    const dir = await workspace()
    const override = "process-env-secret-12345"
    const { client } = await connect(dir, runArgs, "legacy", { TEST_API_KEY: override })
    await client.callTool({ name: "hello", arguments: {} })
    expect(seenKeys.at(-1)).toBe(override)
  })

  it("serves over HTTP", { timeout: 30_000 }, async () => {
    const dir = await workspace()
    const dev = spawnDevLike(dir, [...runArgs, "--http", "--port", "0"])
    try {
      await expect.poll(dev.stderr, POLL).toMatch(/Serving run-test on (http:\S+)/)
      const url = new URL(/Serving run-test on (http:\S+)/.exec(dev.stderr())?.[1] ?? "")
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client")
      const client = new Client({ name: "http", version: "0" })
      await client.connect(new StreamableHTTPClientTransport(url))
      clients.push(client)
      expect((await client.listTools()).tools.map((t) => t.name)).toContain("hello")
    } finally {
      dev.child.kill()
      await dev.exited
    }
  })

  it.each([
    [["run", "missing.yaml"], {}, /Spec file not found/],
    [["run", "kervan.yaml", "--http", "--host", "0.0.0.0"], {}, /needs --allowed-host/],
    [
      ["run", "kervan.yaml", "--allow-private-network"],
      { NODE_ENV: "production" },
      /refused with NODE_ENV=production/,
    ],
    [
      ["run", "kervan.yaml", "--allow-insecure-secrets"],
      { NODE_ENV: "production" },
      /--allow-insecure-secrets .* refused with NODE_ENV=production/,
    ],
    // The spec sends a secret to an http URL: refused unless the development flag is given.
    [
      ["run", "kervan.yaml", "--env-file", ".env", "--allow-private-network"],
      {},
      /secrets are never sent over plain http/,
    ],
    // Node itself scans argv for --env-file, even after the script, and exits (code 9) when the
    // file is missing; otherwise kervan reports it. Either way the server does not start.
    [
      ["run", "kervan.yaml", "--env-file", "nope.env"],
      {},
      /Env file not found: nope\.env|nope\.env: not found/,
    ],
  ])("refuses %j", { timeout: 30_000 }, async (args, env, pattern) => {
    const dir = await workspace()
    const result = spawnSync(process.execPath, [kervanBin, ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, ...env },
      input: "",
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(pattern)
  })

  it("reports a missing env file itself when Node does not", async () => {
    const { loadEnvFiles } = await import("../src/spec-host.js")
    await expect(loadEnvFiles(["nope.env"], {}, os.tmpdir())).rejects.toThrow(
      "Env file not found: nope.env",
    )
  })

  it("reports an invalid spec with line and column", { timeout: 30_000 }, async () => {
    const dir = await workspace(specText().replace("specVersion: 1", "specVersion: 1\nbogus: true"))
    const result = spawnSync(process.execPath, [kervanBin, "run", "kervan.yaml"], {
      cwd: dir,
      encoding: "utf8",
      input: "",
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/kervan\.yaml:\d+:\d+: Unknown field\(s\): bogus/)
  })

  it("reloads with --watch: only changed tools, last good version on errors", {
    timeout: 30_000,
  }, async () => {
    const dir = await workspace()
    const { client, stderr, notifications } = await connect(dir, [...runArgs, "--watch"])
    const before = (await client.listTools()).tools

    await writeFile(
      path.join(dir, "kervan.yaml"),
      specText("Says hello, again").replace(/\n/g, "\r\n"),
    )
    await expect.poll(notifications, POLL).toBe(1)
    const after = (await client.listTools()).tools
    expect(after.find((t) => t.name === "hello")?.description).toBe("Says hello, again")
    expect(after.find((t) => t.name === "fails")).toEqual(before.find((t) => t.name === "fails"))

    await writeFile(path.join(dir, "kervan.yaml"), "specVersion: 1\nname: [broken\n")
    await expect.poll(stderr, POLL).toMatch(/Could not reload[\s\S]*kervan\.yaml:\d+:\d+/)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["hello", "fails"])
    expect(notifications()).toBe(1)
  })
})

describe("kervan dev with a spec", () => {
  it("reloads kervan.yaml in process and keeps unchanged tools", { timeout: 30_000 }, async () => {
    const dir = await workspace()
    await writeFile(path.join(dir, "package.json"), '{ "name": "spec-dev", "type": "module" }\n')
    const { client, notifications } = await connect(dir, [
      "dev",
      "kervan.yaml",
      "--stdio",
      "--env-file",
      ".env",
      ...devFlags,
    ])
    expect(
      JSON.parse(textOf(await client.callTool({ name: "hello", arguments: {} }))).greeting,
    ).toBe("hello")
    await writeFile(path.join(dir, "kervan.yaml"), specText("Changed in dev"))
    await expect.poll(notifications, POLL).toBe(1)
    expect((await client.listTools()).tools[0]?.description).toBe("Changed in dev")
  })
})

describe(".env files stay out of git", () => {
  it("is ignored in the create template", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kervan gitignore "))
    dirs.push(dir)
    const result = await createProject({ dir: path.join(dir, "app"), install: false })
    const ignore = (await readFile(path.join(result.dir, ".gitignore"), "utf8")).split(/\r?\n/)
    expect(ignore).toEqual(expect.arrayContaining([".env", ".env.*"]))
  })

  it("is ignored in the example project", () => {
    for (const file of ["examples/spec/.env", "examples/spec/.env.local"]) {
      const result = spawnSync("git", ["check-ignore", "-q", file], { cwd: repo })
      expect(result.status, `${file} should be ignored`).toBe(0)
    }
    const example = spawnSync("git", ["check-ignore", "-q", "examples/spec/.env.example"], {
      cwd: repo,
    })
    expect(example.status, ".env.example must stay tracked").toBe(1)
  })
})

function spawnDevLike(dir: string, args: string[]) {
  return spawnDev(
    { dir, entry: "", write: async () => {}, cleanup: async () => {} },
    args,
    {},
    true,
  )
}
