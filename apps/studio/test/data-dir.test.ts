// The data directory stays out of git: a directory Studio creates ignores itself, an existing
// .gitignore is left alone, and Studio warns at startup when git could commit the database.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { loadConfig } from "../src/config.js"
import { dataDirectoryGitWarning } from "../src/data-dir.js"
import { openDatabase } from "../src/db/open.js"
import { staticKeyProvider } from "../src/keys.js"
import { DATABASE_FILE, startStudio } from "../src/server.js"

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kervan-data-dir-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

function gitRepo(): string {
  const dir = tempDir()
  execFileSync("git", ["init", "-q", dir])
  return dir
}

const git = (dir: string, ...args: string[]) =>
  execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" })

function open(dir: string) {
  const database = openDatabase(path.join(dir, DATABASE_FILE))
  database.close()
}

describe("a data directory Studio creates", () => {
  it("gets a .gitignore that ignores everything in it", () => {
    const data = path.join(tempDir(), "nested", ".kervan-studio")
    open(data)
    expect(readFileSync(path.join(data, ".gitignore"), "utf8")).toMatch(/^\*$/m)
  })

  it("keeps an existing .gitignore as it is, and adds none to a directory it did not create", () => {
    const withFile = tempDir()
    writeFileSync(path.join(withFile, ".gitignore"), "my own rules\n")
    open(withFile)
    expect(readFileSync(path.join(withFile, ".gitignore"), "utf8")).toBe("my own rules\n")
    // An existing directory may hold other things (even be a repository root): "*" would hide them.
    const existing = tempDir()
    open(existing)
    expect(existsSync(path.join(existing, ".gitignore"))).toBe(false)
  })

  it.skipIf(!hasGit)("leaves nothing for git status to show in a real repository", () => {
    const repo = gitRepo()
    writeFileSync(path.join(repo, "README.md"), "a project\n")
    open(path.join(repo, ".kervan-studio"))
    expect(existsSync(path.join(repo, ".kervan-studio", DATABASE_FILE))).toBe(true)
    expect(git(repo, "status", "--porcelain", "--untracked-files=all")).toBe("?? README.md\n")
    expect(
      dataDirectoryGitWarning(path.join(repo, ".kervan-studio"), DATABASE_FILE),
    ).toBeUndefined()
  })
})

describe.skipIf(!hasGit)("the startup warning", () => {
  it("says when the database could be committed, or is already tracked", () => {
    const repo = gitRepo()
    const data = path.join(repo, "data")
    mkdirSync(data)
    open(data)
    const file = path.join(data, DATABASE_FILE)
    expect(dataDirectoryGitWarning(data, file)).toMatch(/inside a git repository and not ignored/)
    git(repo, "add", "-f", path.join("data", DATABASE_FILE))
    expect(dataDirectoryGitWarning(data, file)).toMatch(/is tracked by git/)
  })

  it("says nothing outside a repository", () => {
    const dir = tempDir()
    open(dir)
    expect(dataDirectoryGitWarning(dir, path.join(dir, DATABASE_FILE))).toBeUndefined()
  })

  it("is printed when Studio starts", async () => {
    const repo = gitRepo()
    const data = path.join(repo, "data")
    mkdirSync(data)
    const lines: string[] = []
    const running = await startStudio(
      loadConfig({ KERVAN_STUDIO_PORT: "0", KERVAN_STUDIO_DATA_DIR: data }, repo),
      {
        print: (line) => lines.push(line),
        resolveSelf: async () => [],
        keys: staticKeyProvider({ version: 1, key: Buffer.alloc(32, 7) }),
      },
    )
    cleanups.push(running.close)
    expect(lines.some((line) => /not ignored, so it could be committed/.test(line))).toBe(true)
  })
})
