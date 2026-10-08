// Security review 3, confirmed: the start-up git check does not run a `git` program planted in
// Studio's working directory (Windows' CreateProcess would search the current directory first;
// libuv, which Node uses, does not). A copy of cmd.exe named git.exe stands in for the planted
// program: had it run, it would answer every git question with exit code 1 and the warning below
// (which only real git produces here) would be missing. Runs the built `dist/` in a child process,
// because the working directory is per process.
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

describe.runIf(process.platform === "win32" && hasGit)(
  "a git.exe in Studio's working directory",
  () => {
    it("is not the git the start-up check runs", () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "kervan-review3-plant-"))
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

      const run = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const { dataDirectoryGitWarning } = await import(${JSON.stringify(dist)})
         console.log(JSON.stringify(dataDirectoryGitWarning(process.argv[1], process.argv[2]) ?? null))`,
          data,
          path.join(data, "studio.db"),
        ],
        { cwd, encoding: "utf8" },
      )
      expect(run.status).toBe(0)
      expect(JSON.parse(run.stdout.trim())).toMatch(/not ignored/)
    })
  },
)
