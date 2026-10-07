// `pnpm try:new <dir>`: the steps it runs (checked with --dry-run, which changes nothing), and
// what it refuses. The full run installs from npm, so it is exercised by hand, not here.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { main, plan, TARBALLS } from "../try-new.mjs"

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function capture() {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(console, "log").mockImplementation((line: string) => out.push(line))
  vi.spyOn(console, "error").mockImplementation((line: string) => err.push(line))
  return { out, err }
}

describe("pnpm try:new", () => {
  it("builds, creates, packs, installs all four packages together, then tests", () => {
    const steps = plan("/tmp/project", "0.1.0")
    expect(steps.map((step) => step.title)).toEqual([
      "Build the packages",
      "Create the project",
      "Pack the local packages",
      "Install them",
      "Run the project's tests",
    ])
    expect(steps[1]?.args.slice(-3)).toEqual(["create", "/tmp/project", "--no-install"])
    expect(steps[3]?.args.map((arg) => arg.replaceAll("\\", "/"))).toEqual([
      "install",
      `${TARBALLS}/kervan-core-0.1.0.tgz`,
      `${TARBALLS}/kervan-transport-0.1.0.tgz`,
      `${TARBALLS}/kervan-spec-runtime-0.1.0.tgz`,
      `${TARBALLS}/kervan-0.1.0.tgz`,
    ])
  })

  it("with --dry-run, prints the steps and changes nothing", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "kervan-try-new-"))
    dirs.push(parent)
    const { out } = capture()
    expect(main(["my-server", "--dry-run"], parent)).toBe(0)
    expect(out.filter((line) => /^\[\d\/5\]/.test(line))).toHaveLength(5)
    expect(out.at(-1)).toBe("Dry run: nothing was changed.")
    expect(existsSync(path.join(parent, "my-server"))).toBe(false)
  })

  it("refuses without a folder, and with a folder that is not empty", () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "kervan-try-new-"))
    dirs.push(parent)
    writeFileSync(path.join(parent, "something.txt"), "x")
    const { err } = capture()
    expect(main([], parent)).toBe(1)
    expect(err.at(-1)).toContain("Give the folder for the new project.")
    expect(main(["."], parent)).toBe(1)
    expect(err.at(-1)).toContain("is not empty")
  })
})
