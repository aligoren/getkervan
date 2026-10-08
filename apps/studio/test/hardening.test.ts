// Hardening after the release review (docs/REVIEW-NOTES.md): a role change ends the user's
// sessions; SQLite keeps temporary data in memory; the start-up git check runs no program a
// repository names; playground signatures have one spelling; secret values are valid Unicode;
// Studio refuses untested Node.js versions; hidden terminal input.
import { execFileSync, spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { runStudioCli } from "../src/cli.js"
import { dataDirectoryGitWarning, gitEnvironment } from "../src/data-dir.js"
import { openDatabase } from "../src/db/open.js"
import { listAudit } from "../src/db/repos/audit.js"
import { NODE_ENGINES, nodeVersionProblem } from "../src/node-version.js"
import { PlaygroundTokens } from "../src/playground.js"
import { DATABASE_FILE } from "../src/server.js"
import { InputCancelled, readHiddenLine, type TerminalInput } from "../src/tty.js"
import { type ApiStudio, apiStudio, PASSWORD } from "./api-helpers.js"
import { echoTool, MODERN, spec, startUpstream, type Upstream } from "./helpers.js"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe("a role change", () => {
  let upstream: Upstream
  beforeAll(async () => {
    upstream = await startUpstream()
  })
  afterAll(() => upstream.close())

  async function setup() {
    const s = apiStudio()
    cleanups.push(() => s.close())
    await s.addUser("admin@example.test", "admin")
    const member = await s.addUser("member@example.test", "member")
    const admin = await s.signIn("admin@example.test")
    const created = await s.request("POST", "/api/servers", {
      ...admin,
      body: { slug: "srv", name: "srv" },
    })
    const serverId = (created.json.server as { id: string }).id
    const saved = await s.request("POST", `/api/servers/${serverId}/versions`, {
      ...admin,
      body: { yaml: spec(echoTool(`${upstream.url}/echo/role`)) },
    })
    const versionId = (saved.json.version as { id: string }).id
    return { s, admin, member, serverId, versionId }
  }

  async function playgroundToken(
    s: ApiStudio,
    who: { cookie: string; csrf: string },
    serverId: string,
    versionId: string,
  ) {
    const response = await s.request(
      "POST",
      `/api/servers/${serverId}/versions/${versionId}/playground`,
      { ...who, body: {} },
    )
    expect(response.status).toBe(200)
    return String(response.json.token)
  }

  function toolsList(s: ApiStudio, serverId: string, bearer: string) {
    return s.request("POST", `/s/${serverId}/mcp`, {
      headers: {
        authorization: `Bearer ${bearer}`,
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MODERN,
        "mcp-method": "tools/list",
      },
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": MODERN,
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      },
    })
  }

  it("to admin ends every session and playground token of the user; they sign in again", async () => {
    const { s, admin, member, serverId, versionId } = await setup()
    const first = await s.signIn("member@example.test")
    const second = await s.signIn("member@example.test", PASSWORD, "203.0.113.9")
    const token = await playgroundToken(s, first, serverId, versionId)
    expect((await toolsList(s, serverId, token)).status).toBe(200)
    const ended = vi.spyOn(s.studio.gateway, "endPlayground")

    const promoted = await s.request("PUT", `/api/users/${member.id}/role`, {
      ...admin,
      body: { role: "admin", adminPassword: PASSWORD },
    })
    expect(promoted.status).toBe(200)

    // A session from before the promotion never becomes an admin's.
    for (const session of [first, second]) {
      expect((await s.request("GET", "/api/me", { cookie: session.cookie })).status).toBe(401)
      expect((await s.request("GET", "/api/users", { cookie: session.cookie })).status).toBe(401)
    }
    expect((await toolsList(s, serverId, token)).status).toBe(401)
    expect(ended).toHaveBeenCalledWith(member.id)

    const event = listAudit(s.database.db, s.scope, { action: "user.role" })[0]
    expect(event?.details).toEqual({ from: "member", to: "admin", sessionsEnded: 2 })

    const fresh = await s.signIn("member@example.test")
    expect((await s.request("GET", "/api/users", { cookie: fresh.cookie })).status).toBe(200)
  })

  it("to member ends the former admin's sessions too", async () => {
    const { s, admin } = await setup()
    const other = await s.addUser("second-admin@example.test", "admin")
    const session = await s.signIn("second-admin@example.test")
    const demoted = await s.request("PUT", `/api/users/${other.id}/role`, {
      ...admin,
      body: { role: "member", adminPassword: PASSWORD },
    })
    expect(demoted.status).toBe(200)
    expect((await s.request("GET", "/api/users", { cookie: session.cookie })).status).toBe(401)
    expect(listAudit(s.database.db, s.scope, { action: "user.role" })[0]?.details).toMatchObject({
      from: "admin",
      to: "member",
      sessionsEnded: 1,
    })
    // The admin who made the change keeps theirs.
    expect((await s.request("GET", "/api/users", { cookie: admin.cookie })).status).toBe(200)
  })

  it("to the same role changes nothing and ends nothing", async () => {
    const { s, admin, member } = await setup()
    const session = await s.signIn("member@example.test")
    const same = await s.request("PUT", `/api/users/${member.id}/role`, {
      ...admin,
      body: { role: "member", adminPassword: PASSWORD },
    })
    expect(same.status).toBe(200)
    expect((await s.request("GET", "/api/me", { cookie: session.cookie })).status).toBe(200)
    expect(listAudit(s.database.db, s.scope, { action: "user.role" })).toEqual([])
  })
})

describe("SQLite temporary data", () => {
  it("stays in memory (temp_store = MEMORY), for a file and in memory", () => {
    const dir = tempDir("kervan-temp-store-")
    for (const file of [path.join(dir, DATABASE_FILE), ":memory:"]) {
      const database = openDatabase(file)
      try {
        // 2 is MEMORY (0 default, 1 FILE).
        expect(database.sqlite.pragma("temp_store", { simple: true })).toBe(2)
      } finally {
        database.close()
      }
    }
  })
})

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

describe.runIf(hasGit)("the start-up git check in an untrusted repository", () => {
  /** A repository whose own config runs a program (fsmonitor) that leaves a marker file. */
  function hostileRepository() {
    const root = tempDir("kervan-git-hostile-")
    const repo = path.join(root, "repo")
    const marker = path.join(root, "HOOK-RAN").replaceAll("\\", "/")
    execFileSync("git", ["init", "-q", repo])
    const hook = path.join(root, "fsmonitor-hook.sh")
    writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`)
    chmodSync(hook, 0o755)
    execFileSync("git", ["-C", repo, "config", "core.fsmonitor", hook.replaceAll("\\", "/")])
    const data = path.join(repo, "data")
    mkdirSync(data)
    writeFileSync(path.join(data, DATABASE_FILE), "")
    return { data, marker }
  }

  it("does not run the repository's fsmonitor program", () => {
    const { data, marker } = hostileRepository()
    // The repository really is hostile: plain git runs the program.
    spawnSync("git", ["-C", data, "check-ignore", "-q", DATABASE_FILE])
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)

    const warning = dataDirectoryGitWarning(data, path.join(data, DATABASE_FILE))
    expect(existsSync(marker)).toBe(false)
    // It still answers: the database is in a repository and not ignored.
    expect(warning).toMatch(/not ignored/)
  })

  it("ignores GIT_* variables of Studio's environment (here one that writes a file)", () => {
    const { data } = hostileRepository()
    const trace = path.join(path.dirname(path.dirname(data)), "trace.txt")
    // The variable really writes: plain git with it creates the file.
    spawnSync("git", ["-C", data, "rev-parse"], { env: { ...process.env, GIT_TRACE: trace } })
    expect(existsSync(trace)).toBe(true)
    rmSync(trace)

    vi.stubEnv("GIT_TRACE", trace)
    vi.stubEnv("GIT_DIR", path.join(data, "nowhere"))
    try {
      dataDirectoryGitWarning(data, path.join(data, DATABASE_FILE))
    } finally {
      vi.unstubAllEnvs()
    }
    expect(existsSync(trace)).toBe(false)
  })

  it("passes git no GIT_* variable and no config file outside the repository", () => {
    const clean = gitEnvironment({
      PATH: "/usr/bin",
      HOME: "/home/someone",
      GIT_DIR: "/elsewhere",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: "/tmp/run-me",
      GIT_EXTERNAL_DIFF: "/tmp/run-me",
      KERVAN_STUDIO_MASTER_KEY: "never-for-git",
    })
    expect(clean).toEqual({
      PATH: "/usr/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    })
  })
})

describe("playground token signatures", () => {
  it("are accepted in their one canonical spelling only", () => {
    const tokens = new PlaygroundTokens()
    const { token } = tokens.issue({
      workspaceId: "w",
      serverId: "s",
      versionId: "v",
      userId: "u",
      sessionHash: "h",
    })
    expect(tokens.verify(token)).toBeDefined()
    const [payload, signature = ""] = token.slice(4).split(".")
    // 32 bytes in 43 characters: the last one carries 2 bits that decoding ignores.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    const last = alphabet.indexOf(signature.slice(-1))
    const twin = `${signature.slice(0, -1)}${alphabet[last ^ 1]}`
    expect(Buffer.from(twin, "base64url")).toEqual(Buffer.from(signature, "base64url"))
    for (const variant of [twin, `${signature}=`, `${signature}==`, ` ${signature}`]) {
      expect(tokens.verify(`kvp_${payload}.${variant}`)).toBeUndefined()
    }
  })
})

describe("secret values", () => {
  it("must be valid Unicode text (an unpaired surrogate is refused, not stored)", async () => {
    const s = apiStudio()
    cleanups.push(() => s.close())
    await s.addUser("admin@example.test", "admin")
    const admin = await s.signIn("admin@example.test")
    const created = await s.request("POST", "/api/servers", {
      ...admin,
      body: { slug: "srv", name: "srv" },
    })
    const serverId = (created.json.server as { id: string }).id
    const value = `long-enough-${String.fromCodePoint(0xd800)}`
    const response = await s.request("PUT", `/api/servers/${serverId}/secrets/API_KEY`, {
      ...admin,
      body: { value, allowedHosts: ["api.example.com"] },
    })
    expect(response.status).toBe(400)
    expect(response.json.error).toMatch(/valid Unicode text/)
    expect((await s.studio.listSecrets(s.scope, serverId)).length).toBe(0)
  })
})

describe("the Node.js version", () => {
  it("is refused below the oldest tested release of each line", () => {
    for (const version of [
      "20.19.0",
      "22.0.0",
      "22.12.0",
      "22.13.0",
      "22.17.0",
      "23.11.0",
      "24.14.9",
      "v18.0.0",
      "garbage",
    ]) {
      expect(nodeVersionProblem(version), version).toMatch(
        /needs Node\.js 22\.23\.3 or a later 22\.x, or 24\.15\.0 or later/,
      )
    }
    for (const version of ["22.23.3", "22.24.0", "v24.15.0", "24.21.0", "25.0.0", "26.2.1"]) {
      expect(nodeVersionProblem(version), version).toBeUndefined()
    }
  })

  it("matches the engines field of Studio's package.json", () => {
    const manifest = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { engines: { node: string } }
    expect(manifest.engines.node).toBe(NODE_ENGINES)
  })

  it("stops every command before it does anything", async () => {
    const dir = tempDir("kervan-node-version-")
    const err: string[] = []
    const code = await runStudioCli(["start"], {
      out: () => {},
      err: (line) => err.push(line),
      env: { KERVAN_STUDIO_DATA_DIR: path.join(dir, "data") },
      cwd: dir,
      readStdin: async () => "",
      nodeVersion: "22.12.0",
    })
    expect(code).toBe(1)
    expect(err.join("\n")).toMatch(/this is 22\.12\.0/)
    expect(existsSync(path.join(dir, "data"))).toBe(false)
  })

  it("is checked by the kervan-studio command before Studio loads", () => {
    const dir = tempDir("kervan-node-version-bin-")
    const bin = fileURLToPath(new URL("../bin/kervan-studio.js", import.meta.url))
    // An older Node.js, as far as Studio can tell, and a hook that reports loading Studio's CLI.
    const fake =
      'data:text/javascript,Object.defineProperty(process,"versions",{value:{...process.versions,node:"22.12.0"}});' +
      'import{registerHooks}from"node:module";registerHooks({load(u,c,n){if(u.endsWith("/dist/cli.js"))process.stderr.write("LOADING-CLI ");return n(u,c)}})'
    const result = spawnSync(process.execPath, ["--import", fake, bin, "start"], {
      cwd: dir,
      env: { ...process.env, KERVAN_STUDIO_DATA_DIR: path.join(dir, "data") },
      encoding: "utf8",
    })
    expect(result.stderr).not.toContain("LOADING-CLI")
    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/^Error: Kervan Studio needs Node\.js .*this is 22\.12\.0/)
    expect(existsSync(path.join(dir, "data"))).toBe(false)
  })
})

describe("hidden terminal input", () => {
  const key = (code: number) => String.fromCodePoint(code)

  function terminal() {
    const listeners = { data: [] as ((chunk: string) => void)[], end: [] as (() => void)[] }
    const modes: boolean[] = []
    const input: TerminalInput = {
      setRawMode: (mode: boolean) => modes.push(mode),
      resume: () => {},
      pause: () => {},
      on: (event: "data" | "end", listener: never) => listeners[event].push(listener),
      off: (event: "data" | "end", listener: never) => {
        listeners[event] = listeners[event].filter((each) => each !== listener) as never
      },
    }
    const written: string[] = []
    const type = (text: string) => {
      for (const listener of [...listeners.data]) listener(text)
    }
    return { input, written, output: { write: (t: string) => written.push(t) }, type, modes }
  }

  it("reads a line without echoing it, with backspace, ignoring escape sequences", async () => {
    const t = terminal()
    const reading = readHiddenLine("Password: ", t.input, t.output)
    t.type("secret1")
    t.type(key(0x7f))
    t.type(`${key(0x1b)}[A`)
    t.type(`X${key(1)}Y`)
    t.type(`pass${key(0x1f511)}\r`)
    expect(await reading).toBe(`secretXYpass${key(0x1f511)}`)
    expect(t.written).toEqual(["Password: ", "\n"])
    expect(t.modes).toEqual([true, false])
  })

  it("cancels on Ctrl+C and leaves raw mode", async () => {
    const t = terminal()
    const reading = readHiddenLine("Password: ", t.input, t.output)
    t.type(`abc${key(3)}`)
    await expect(reading).rejects.toBeInstanceOf(InputCancelled)
    expect(t.modes).toEqual([true, false])
  })
})
