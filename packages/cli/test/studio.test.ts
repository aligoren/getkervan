import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { run } from "../src/index.js"

const studioDir = fileURLToPath(new URL("../../../apps/studio", import.meta.url))
const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function capture(cwd: string) {
  const out: string[] = []
  const err: string[] = []
  return { io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), cwd }, out, err }
}

describe("kervan studio", () => {
  it("explains when Studio is not installed", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kervan-no-studio-"))
    temps.push(dir)
    const { io, err } = capture(dir)
    expect(await run(["studio", "reset-admin"], io)).toBe(1)
    expect(err.join("\n")).toMatch(/Kervan Studio is not installed/)
  })

  // A package.json named @kervan/studio in a parent folder must not point the CLI at a module
  // outside its own package (say, in another user's folder on a shared machine).
  it("does not load a Studio CLI module outside the package that names it", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "kervan-studio-escape-"))
    temps.push(root)
    const marker = path.join(root, "LOADED")
    writeFileSync(
      path.join(root, "evil.mjs"),
      `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "x")\n`,
    )
    for (const target of ["../evil.mjs", "../pkg/../evil.mjs", path.join(root, "evil.mjs")]) {
      const pkg = path.join(root, "pkg")
      mkdirSync(path.join(pkg, "project"), { recursive: true })
      writeFileSync(
        path.join(pkg, "package.json"),
        JSON.stringify({ name: "@kervan/studio", exports: { "./cli": { default: target } } }),
      )
      const { io, err } = capture(path.join(pkg, "project"))
      expect(await run(["studio", "--help"], io)).toBe(1)
      expect(err.join("\n")).toMatch(/Kervan Studio is not installed/)
      expect(existsSync(marker)).toBe(false)
    }
  })

  // Loads all of Studio (its server, database driver and spec runtime): slow under a busy test run.
  it("forwards to Studio's command line when it is installed", { timeout: 30_000 }, async () => {
    const { io, out } = capture(studioDir)
    expect(await run(["studio", "--help"], io)).toBe(0)
    expect(out.join("\n")).toContain("Usage: kervan-studio <command>")
  })
})
