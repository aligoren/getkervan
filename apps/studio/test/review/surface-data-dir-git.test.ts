// Security review (release): the data directory and git. In WAL mode SQLite keeps `studio.db-wal`
// (recent pages: audit rows, session hashes, encrypted secrets) and `studio.db-shm` next to the
// database while Studio runs, and a very common rule like `*.db` ignores the database but not
// those two. Studio's start-up warning asks git about all three.
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { dataDirectoryGitWarning } from "../../src/data-dir.js"
import { openDatabase } from "../../src/db/open.js"
import { DATABASE_FILE } from "../../src/server.js"

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

describe.runIf(hasGit)("a data directory inside a git repository", () => {
  it("is warned about when git would commit any of the database's files", () => {
    const repo = mkdtempSync(path.join(os.tmpdir(), "kervan-review-git-"))
    cleanups.push(() => rmSync(repo, { recursive: true, force: true }))
    execFileSync("git", ["init", "-q", repo])
    writeFileSync(path.join(repo, ".gitignore"), "*.db\n")
    // A folder the user made (so Studio adds no "*" .gitignore of its own).
    const data = path.join(repo, "data")
    mkdirSync(data)
    const file = path.join(data, DATABASE_FILE)
    const database = openDatabase(file)
    cleanups.push(() => database.close())
    database.sqlite.exec(
      "CREATE TABLE review_probe (x TEXT); INSERT INTO review_probe VALUES ('row')",
    )

    const warning = dataDirectoryGitWarning(data, file)
    const committable = execFileSync(
      "git",
      ["-C", repo, "status", "--porcelain", "--untracked-files=all"],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter((line) => line.includes(DATABASE_FILE))
    // Whenever git would commit one of the files, Studio warns.
    if (warning === undefined) expect(committable).toEqual([])
  })
})
