import { spawnSync } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { ChildServer, killTree, taskkillProgram } from "../src/dev/child.js"
import { devPreflight } from "../src/dev/index.js"
import { collectSecrets, createRedactor, REDACTED } from "../src/dev/redact.js"
import { findProjectRoot, shouldReload, watchProject } from "../src/dev/watch.js"
import { isAlive, makeProject, type Project, repo } from "./dev-helpers.js"

const POLL = { timeout: 15_000, interval: 50 }
const projects: Project[] = []
const cleanupDirs: string[] = []
afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) => project.cleanup()))
  await Promise.all(
    cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5 })),
  )
})

async function project() {
  const p = await makeProject()
  projects.push(p)
  return p
}

function startChild(p: Project, env: Record<string, string> = {}) {
  const stderr: string[] = []
  const started = ChildServer.start({
    entry: p.entry,
    cwd: p.dir,
    env: { ...process.env, KERVAN_TRANSPORT: "stdio", ...env },
    onStderr: (line) => stderr.push(line),
    onToolsChanged: () => {},
    onError: () => {},
  })
  return { started, stderr }
}

describe("ChildServer shutdown (no signals)", () => {
  it("stops gracefully by closing stdin", { timeout: 30_000 }, async () => {
    const { started } = startChild(await project())
    const child = await started
    expect(child.tools.map((tool) => tool.name)).toContain("version")
    expect(await child.stop(5_000)).toBe("graceful")
    expect(await child.exited).toBe(0)
    expect(isAlive(child.pid)).toBe(false)
  })

  it("kills the whole process tree when the server ignores stdin EOF", {
    timeout: 30_000,
  }, async () => {
    const { started, stderr } = startChild(await project(), { FIXTURE_STUBBORN: "1" })
    const child = await started
    await expect.poll(() => stderr.join("\n"), POLL).toMatch(/grandchild (\d+)/)
    const grandchild = Number(/grandchild (\d+)/.exec(stderr.join("\n"))?.[1])
    expect(isAlive(grandchild)).toBe(true)

    const started_at = Date.now()
    expect(await child.stop(300)).toBe("forced")
    expect(Date.now() - started_at).toBeGreaterThanOrEqual(300)
    expect(isAlive(child.pid)).toBe(false)
    // taskkill /T on Windows, the process group on POSIX: the grandchild goes too.
    await expect.poll(() => isAlive(grandchild), POLL).toBe(false)
  })

  it("waits for in-flight calls before stopping when retired", { timeout: 30_000 }, async () => {
    const { started } = startChild(await project())
    const child = await started
    const controller = new AbortController()
    const ctx = {
      signal: controller.signal,
      progress: async () => {},
    } as unknown as Parameters<ChildServer["call"]>[2]
    const call = child.call("slow", { ms: 800 }, ctx)
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(child.inflight).toBe(1)
    const method = await child.retire(5_000)
    expect(method).toBe("graceful")
    expect(await call).toMatchObject({ content: [{ type: "text", text: "v1" }] })
  })
})

describe("killTree", () => {
  it("kills the process group on POSIX and falls back to the process", () => {
    const calls: string[] = []
    const child = {
      pid: 4242,
      kill: (signal?: NodeJS.Signals) => {
        calls.push(`kill ${signal}`)
        return true
      },
    }
    killTree(child, "linux", (pid, signal) => {
      calls.push(`group ${pid} ${signal}`)
    })
    expect(calls).toEqual(["group -4242 SIGKILL"])

    calls.length = 0
    killTree(child, "darwin", () => {
      throw new Error("ESRCH")
    })
    expect(calls).toEqual(["kill SIGKILL"])
  })

  it("runs Windows' own taskkill by its full path, never one found in the current directory", () => {
    expect(taskkillProgram({ SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\taskkill.exe")
    expect(taskkillProgram({ WINDIR: "C:\\Windows" })).toBe("C:\\Windows\\System32\\taskkill.exe")
    // A relative or missing root would be looked up from the current directory: not used.
    for (const SystemRoot of [undefined, "Windows", ".\\Windows", "\\Windows"]) {
      expect(taskkillProgram({ SystemRoot }), String(SystemRoot)).toBe(
        "C:\\Windows\\System32\\taskkill.exe",
      )
    }
  })

  // End to end on Windows: a taskkill.exe planted in the working directory (a copy of cmd.exe,
  // which would exit without killing anything) must not be what kills the server. Runs the built
  // dist in a child process without NoDefaultCurrentDirectoryInExePath (libuv reads it from the
  // spawning process; with it set, the bare name would be safe and the test blind).
  it.runIf(process.platform === "win32")(
    "kills the tree even with a taskkill.exe planted in the working directory",
    async () => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "kervan-taskkill-plant-"))
      cleanupDirs.push(cwd)
      await copyFile(
        path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
        path.join(cwd, "taskkill.exe"),
      )
      const env = { ...process.env }
      for (const name of Object.keys(env)) {
        if (name.toLowerCase() === "nodefaultcurrentdirectoryinexepath") delete env[name]
      }
      const dist = pathToFileURL(path.join(repo, "packages/cli/dist/dev/child.js")).href
      const script = `
        import { spawn } from "node:child_process"
        const { killTree } = await import(${JSON.stringify(dist)})
        const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
        await new Promise((resolve) => setTimeout(resolve, 300))
        killTree(victim, "win32")
        await new Promise((resolve) => setTimeout(resolve, 1000))
        let alive = true
        try { process.kill(victim.pid, 0) } catch { alive = false }
        if (alive) victim.kill()
        console.log(alive ? "alive" : "killed")`
      const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        cwd,
        env,
        encoding: "utf8",
      })
      expect(`${run.stdout}${run.stderr}`.trim()).toBe("killed")
    },
  )
})

describe("watching", () => {
  it.each([
    ["src/server.ts", true],
    ["src\\deep\\tool.mts", true],
    ["config.json", true],
    ["README.md", false],
    ["node_modules\\pkg\\index.js", false],
    ["node_modules/pkg/index.js", false],
    ["dist/index.js", false],
    [".git\\index", false],
    ["src\\NODE_MODULES_NOTES.ts", true],
  ])("shouldReload(%j) → %s", (file, expected) => {
    expect(shouldReload(file)).toBe(expected)
  })

  it("reloads when the platform does not name the file", () => {
    expect(shouldReload(null)).toBe(true)
  })

  it("finds the project root from a nested directory", async () => {
    const p = await project()
    const nested = path.join(p.dir, "src", "a", "b")
    await mkdir(nested, { recursive: true })
    expect(findProjectRoot(nested)).toBe(p.dir)
  })

  it("sees changes in nested folders and ignores node_modules", { timeout: 30_000 }, async () => {
    const p = await project()
    await mkdir(path.join(p.dir, "src", "tools", "deep"), { recursive: true })
    await mkdir(path.join(p.dir, "node_modules", "ignored"), { recursive: true })
    const batches: string[][] = []
    const stop = watchProject(p.dir, (files) => batches.push(files), 50)
    try {
      await new Promise((resolve) => setTimeout(resolve, 200))
      await writeFile(path.join(p.dir, "node_modules", "ignored", "x.js"), "1")
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(batches).toEqual([])

      await writeFile(path.join(p.dir, "src", "tools", "deep", "tool.ts"), "export {}\r\n")
      await expect.poll(() => batches.length, POLL).toBeGreaterThan(0)
      const reported = batches.flat().map((file) => file.split(/[\\/]/).join("/"))
      expect(reported).toContain("src/tools/deep/tool.ts")
    } finally {
      stop()
    }
  })
})

describe("redaction", () => {
  it("collects secret-looking environment values", () => {
    const secrets = collectSecrets({
      OPENAI_API_KEY: "sk-abcdef123456",
      GITHUB_TOKEN: "ghp_0123456789",
      DB_PASSWORD: "hunter2hunter2",
      DATABASE_URL: "postgres://u:p@h/db",
      PATH: "C:\\Windows\\System32",
      HOME: "/home/someone",
      SHORT_TOKEN: "abc",
      KEY: "value-for-key",
    })
    expect(secrets).toEqual(
      expect.arrayContaining([
        "sk-abcdef123456",
        "ghp_0123456789",
        "hunter2hunter2",
        "postgres://u:p@h/db",
        "value-for-key",
      ]),
    )
    expect(secrets).not.toContain("C:\\Windows\\System32")
    expect(secrets).not.toContain("abc")
  })

  it("replaces secrets and URL credentials", () => {
    const redact = createRedactor(["sk-abcdef123456"])
    expect(redact("key sk-abcdef123456 used twice: sk-abcdef123456")).toBe(
      `key ${REDACTED} used twice: ${REDACTED}`,
    )
    expect(redact("connect to postgres://admin:s3cr3t@db:5432/app failed")).toBe(
      `connect to postgres://admin:${REDACTED}@db:5432/app failed`,
    )
  })
})

describe("dev only", () => {
  it("core and transport contain no file watching code", async () => {
    for (const pkg of ["core", "transport"]) {
      const dir = path.join(repo, "packages", pkg, "src")
      for (const file of await readdir(dir)) {
        const source = await readFile(path.join(dir, file), "utf8")
        expect(source, `${pkg}/src/${file}`).not.toMatch(/\bwatch\s*\(|chokidar|fs\.watch/)
      }
    }
  })

  it("preflight refuses production and old Node.js for .ts entries", async () => {
    const p = await project()
    const runtime = {
      version: "v24.21.0",
      platform: "linux" as const,
      typescript: "strip" as const,
    }
    expect(devPreflight({ entry: p.entry, env: {}, runtime }).errors).toEqual([])
    expect(
      devPreflight({ entry: p.entry, env: { NODE_ENV: "production" }, runtime }).errors.join(),
    ).toMatch(/production/)
    expect(
      devPreflight({
        entry: p.entry,
        env: {},
        runtime: { ...runtime, version: "v22.17.0" },
      }).errors.join(),
    ).toMatch(/22\.23\.3/)
    expect(
      devPreflight({ entry: path.join(p.dir, "missing.ts"), env: {}, runtime }).errors.join(),
    ).toMatch(/not found/)
    expect(
      devPreflight({
        entry: p.entry,
        env: {},
        runtime: { ...runtime, platform: "win32", version: "v24.15.0" },
      }).errors.join(),
    ).toMatch(/24\.21\.0 or later/)
  })
})
