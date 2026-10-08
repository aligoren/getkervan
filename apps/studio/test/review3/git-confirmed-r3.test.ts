// Security review 3, confirmed: the start-up git check does not run a `git` program planted in
// Studio's working directory. Run by its bare name, git would be looked up in the current
// directory first on Windows: libuv (Node's child processes) searches it, as CreateProcess does,
// unless NoDefaultCurrentDirectoryInExePath is set. Studio therefore runs git by its full path,
// from PATH's absolute folders only (`gitProgram`).
//
// The variable is removed from the child's environment here: a machine that sets it (some
// terminals and agents do) would otherwise hide the bug, as it did until the first CI run on
// GitHub's Windows runners, which do not set it.
//
// A copy of cmd.exe named git.exe stands in for the planted program. Asked a git question with
// its standard input closed, it exits with 0, so the check would report the database as tracked;
// real git reports it as not ignored. Runs the built `dist/` in a child process, because the
// working directory is per process.
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const cleanups: (() => unknown)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

const dist = pathToFileURL(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/data-dir.js"),
).href

/** The environment without the variable that turns the current-directory lookup off. */
function withoutCwdOptOut(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of Object.keys(env)) {
    if (name.toLowerCase() === "nodefaultcurrentdirectoryinexepath") delete env[name]
  }
  return env
}

/**
 * What a failed run should show, so a CI log explains itself: what git sees in the repository,
 * the few config keys that change its answers (named one by one: never `config --list`, which
 * can hold credentials), the platform and the temporary folder's real path.
 */
function diagnostics(repo: string, cwd: string, output: string): string {
  const git = (args: string[]) => {
    const run = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", cwd: os.tmpdir() })
    return `${run.status}: ${(run.stdout + run.stderr).trim()}`
  }
  const keys = ["core.autocrlf", "core.fsmonitor", "safe.directory", "core.excludesFile"]
  return [
    `child output: ${output}`,
    `process.platform: ${process.platform}`,
    `os.tmpdir(): ${os.tmpdir()} (real path ${realpathSync.native(os.tmpdir())})`,
    `cwd: ${cwd}`,
    `NoDefaultCurrentDirectoryInExePath in the test's environment: ${
      Object.keys(process.env).some(
        (name) => name.toLowerCase() === "nodefaultcurrentdirectoryinexepath",
      )
        ? "set (removed for the child)"
        : "not set"
    }`,
    `git ls-files: ${git(["ls-files"])}`,
    `git status --porcelain: ${git(["status", "--porcelain"])}`,
    ...keys.map((key) => `git config --get-all ${key}: ${git(["config", "--get-all", key])}`),
  ].join("\n")
}

/** A repository with an untracked database, and a cwd holding a planted git.exe. */
function plant(base = os.tmpdir()) {
  const root = mkdtempSync(path.join(base, "kervan-review3-plant-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const cwd = path.join(root, "cwd")
  mkdirSync(cwd)
  copyFileSync(
    path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
    path.join(cwd, "git.exe"),
  )
  const repo = path.join(root, "repo")
  execFileSync("git", ["init", "-q", repo])
  const data = path.join(repo, "data")
  mkdirSync(data)
  writeFileSync(path.join(data, "studio.db"), "")
  return { cwd, repo, data }
}

/** Runs the check in a child process whose working directory holds the planted git.exe. */
function checkFrom(cwd: string, data: string, file: string) {
  const run = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `const { dataDirectoryGitWarning } = await import(${JSON.stringify(dist)})
       console.log(JSON.stringify(dataDirectoryGitWarning(process.argv[1], process.argv[2]) ?? null))`,
      data,
      file,
    ],
    { cwd, encoding: "utf8", env: withoutCwdOptOut() },
  )
  return { status: run.status, output: `${run.stdout}${run.stderr}`.trim(), stdout: run.stdout }
}

describe.runIf(process.platform === "win32" && hasGit)(
  "a git.exe in Studio's working directory",
  () => {
    it("is found first by a bare name (the hazard is real on this machine)", () => {
      const { cwd } = plant()
      // From a child process without the variable: libuv reads it from the spawning process.
      const run = spawnSync(
        process.execPath,
        [
          "-e",
          `const r = require("node:child_process").spawnSync("git", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
           process.stdout.write(r.stdout ?? "")`,
        ],
        { cwd, encoding: "utf8", env: withoutCwdOptOut() },
      )
      // cmd.exe answered, not git: a git run by its bare name would be the planted one.
      expect(run.status).toBe(0)
      expect(run.stdout).not.toMatch(/^git version/)
    })

    it("is not the git the start-up check runs", () => {
      const { cwd, repo, data } = plant()
      const run = checkFrom(cwd, data, path.join(data, "studio.db"))
      const why = diagnostics(repo, cwd, run.output)
      expect(run.status, why).toBe(0)
      expect(JSON.parse(run.stdout.trim()), why).toMatch(/not ignored/)
    })

    it("nor when the data directory is named by its 8.3 short path, in mixed case and separators", () => {
      // A folder with a long name has a short name (KERVAN~1) where the volume keeps them.
      const long = mkdtempSync(path.join(os.tmpdir(), "Kervan Long Folder Name "))
      cleanups.push(() => rmSync(long, { recursive: true, force: true }))
      const { cwd, repo, data } = plant(long)
      // Verbatim: Node would escape the inner quotes for cmd.exe as \" and break the path.
      const short = spawnSync(
        "cmd.exe",
        ["/d", "/s", "/c", `"for %I in ("${data}") do @echo %~sI"`],
        { encoding: "utf8", windowsVerbatimArguments: true },
      ).stdout.trim()
      // The short form must differ, or this case would only repeat the one above.
      expect(short).toMatch(/~\d/)
      const variants = [short, short.toLowerCase(), short.replaceAll("\\", "/")]
      const answers = (pattern: RegExp) => {
        for (const variant of variants) {
          const run = checkFrom(cwd, variant, `${variant}\\studio.db`)
          const why = `data directory given as ${variant}\n${diagnostics(repo, cwd, run.output)}`
          expect(run.status, why).toBe(0)
          expect(JSON.parse(run.stdout.trim()), why).toMatch(pattern)
        }
      }
      answers(/not ignored/)
      // And once the database is committed, every form still says so (a miss here is the
      // dangerous direction: the warning would be silent).
      execFileSync("git", ["-C", repo, "add", "data/studio.db"])
      answers(/is tracked by git/)
    }, 30_000) // six child processes, each running git twice
  },
)
