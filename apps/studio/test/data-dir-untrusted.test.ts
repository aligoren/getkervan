// The start-up git check runs git only on a repository that cannot make git open files the
// repository chooses (security review 3: on Windows a `//host/share` path sends the user's NTLM
// credentials to `host`). For any other repository Studio does not run git and says so, unless the
// data directory already ignores everything. A trace file shows whether git ran at all.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { dataDirectoryGitWarning } from "../src/data-dir.js"
import { DATABASE_FILE } from "../src/server.js"

const cleanups: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
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

function folder(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "kervan-untrusted-git-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** A repository with a data folder in it; `fsmonitor` leaves a marker file if git runs it. */
function repository(root: string) {
  const repo = path.join(root, "repo")
  execFileSync("git", ["init", "-q", repo])
  const marker = path.join(root, "GIT-RAN").replaceAll("\\", "/")
  const hook = path.join(root, "hook.sh")
  writeFileSync(hook, `#!/bin/sh\necho ran >> '${marker}'\nexit 1\n`, { mode: 0o755 })
  const data = path.join(repo, "data")
  mkdirSync(data)
  writeFileSync(path.join(data, DATABASE_FILE), "")
  return { repo, data, marker, hook: hook.replaceAll("\\", "/") }
}

const check = (data: string) => dataDirectoryGitWarning(data, path.join(data, DATABASE_FILE))

describe.runIf(hasGit)("a repository Studio does not run git on", () => {
  it("a .git file in a parent folder: git is not run, Studio warns", () => {
    const root = folder()
    // The .git file points at a real repository whose own config would run a program.
    const target = repository(root)
    execFileSync("git", ["-C", target.repo, "config", "core.fsmonitor", target.hook])
    const project = path.join(root, "project")
    const data = path.join(project, "data")
    mkdirSync(data, { recursive: true })
    writeFileSync(path.join(project, ".git"), `gitdir: ${path.join(target.repo, ".git")}\n`)

    expect(check(data)).toMatch(/inside a git working tree .* that Studio does not inspect/)
    expect(existsSync(target.marker)).toBe(false)
    // Studio's own "*" .gitignore in the data directory is enough.
    writeFileSync(path.join(data, ".gitignore"), "# Kervan Studio's data\n*\n")
    expect(check(data)).toBeUndefined()
  })

  for (const [key, value] of [
    ["include.path", "elsewhere.cfg"],
    ["core.excludesFile", "elsewhere-ignore"],
    ["core.worktree", ".."],
    ["core.attributesFile", "elsewhere-attributes"],
  ] as const) {
    it(`a config that sets ${key}: git is not run`, () => {
      const root = folder()
      const { repo, data, marker, hook } = repository(root)
      execFileSync("git", ["-C", repo, "config", "core.fsmonitor", hook])
      execFileSync("git", ["-C", repo, "config", key, value])
      expect(check(data)).toMatch(/does not inspect/)
      expect(existsSync(marker)).toBe(false)
    })
  }

  it("a .git directory that reads the rest from elsewhere (commondir): git is not run", () => {
    const root = folder()
    const { repo, data, marker, hook } = repository(root)
    execFileSync("git", ["-C", repo, "config", "core.fsmonitor", hook])
    writeFileSync(path.join(repo, ".git", "commondir"), "../../elsewhere/.git\n")
    expect(check(data)).toMatch(/does not inspect/)
    expect(existsSync(marker)).toBe(false)
  })

  it.runIf(process.platform !== "win32")("a .git that is a symbolic link: git is not run", () => {
    const root = folder()
    const target = repository(root)
    const project = path.join(root, "project")
    const data = path.join(project, "data")
    mkdirSync(data, { recursive: true })
    symlinkSync(path.join(target.repo, ".git"), path.join(project, ".git"))
    expect(check(data)).toMatch(/does not inspect/)
  })

  // Creating symbolic links needs a privilege on Windows.
  it.runIf(process.platform !== "win32")(
    "a symbolic link among .git's files: git is not run",
    () => {
      const root = folder()
      const { repo, data } = repository(root)
      rmSync(path.join(repo, ".git", "info", "exclude"), { force: true })
      symlinkSync(path.join(root, "elsewhere"), path.join(repo, ".git", "info", "exclude"))
      expect(check(data)).toMatch(/does not inspect/)
    },
  )

  it.runIf(typeof process.getuid === "function")(
    "a .git directory another user owns: git is not run",
    () => {
      const root = folder()
      const { data } = repository(root)
      vi.spyOn(process, "getuid").mockReturnValue(4242)
      expect(check(data)).toMatch(/does not inspect/)
    },
  )

  it("an ordinary repository is still checked with git", () => {
    const root = folder()
    const { repo, data } = repository(root)
    expect(check(data)).toMatch(/not ignored/)
    writeFileSync(path.join(repo, ".gitignore"), "data/\n")
    expect(check(data)).toBeUndefined()
    // A remote URL (with "//" in it) is fine.
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://example.com/r.git"])
    expect(check(data)).toBeUndefined()
  })

  it("no repository: nothing to say", () => {
    const root = folder()
    const data = path.join(root, "data")
    mkdirSync(data)
    // Unless the temp folder itself is inside a repository.
    if (!existsSync(path.join(os.tmpdir(), ".git"))) expect(check(data)).toBeUndefined()
  })
})
