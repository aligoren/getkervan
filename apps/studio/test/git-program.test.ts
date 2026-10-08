// Which git the start-up check runs: found in PATH's absolute folders only, never in the current
// directory (an empty, "." or relative PATH entry), so a git planted next to Studio cannot run.
// The planted-program case end to end is in test/review3/git-confirmed-r3.test.ts (Windows).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { gitProgram } from "../src/data-dir.js"

const windows = process.platform === "win32"
const name = windows ? "git.exe" : "git"
const separator = windows ? ";" : ":"
const cleanups: (() => unknown)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

/** A temporary folder with a `git` in it; returns the folder. */
function folderWithGit(parent?: string): string {
  const dir = parent ?? mkdtempSync(path.join(os.tmpdir(), "kervan-git-program-"))
  if (!parent) cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, name), "")
  return dir
}

describe("gitProgram", () => {
  it("returns the git in the first absolute PATH folder that has one", () => {
    const empty = mkdtempSync(path.join(os.tmpdir(), "kervan-git-program-"))
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }))
    const dir = folderWithGit()
    expect(gitProgram({ PATH: [empty, dir].join(separator) }, process.platform)).toBe(
      path.join(dir, name),
    )
  })

  it("never looks in the current directory: empty, '.' and relative entries are skipped", () => {
    const cwd = folderWithGit()
    folderWithGit(path.join(cwd, "sub"))
    const previous = process.cwd()
    process.chdir(cwd)
    try {
      for (const PATH of ["", separator, ".", "./", `.${separator}sub`, "sub", `sub${separator}`]) {
        expect(gitProgram({ PATH }, process.platform), JSON.stringify(PATH)).toBeUndefined()
      }
    } finally {
      process.chdir(previous)
    }
  })

  it.runIf(windows)(
    "reads Windows' Path, with quoted folders, and skips drive-relative ones",
    () => {
      const dir = folderWithGit()
      expect(gitProgram({ Path: `"${dir}"` }, "win32")).toBe(path.join(dir, "git.exe"))
      // "C:folder" and "\folder" depend on the current drive and its current directory. From the
      // drive's root both name the real folder, so only the rule can turn them down.
      const drive = dir.slice(0, 2)
      const previous = process.cwd()
      process.chdir(`${drive}\\`)
      try {
        expect(gitProgram({ Path: `${drive}${dir.slice(3)}` }, "win32")).toBeUndefined()
        expect(gitProgram({ Path: dir.slice(2) }, "win32")).toBeUndefined()
      } finally {
        process.chdir(previous)
      }
    },
  )

  it("is undefined without PATH: then Studio says nothing about git", () => {
    expect(gitProgram({}, process.platform)).toBeUndefined()
  })
})
