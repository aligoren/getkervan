// The publish guard: off unless KERVAN_ALLOW_PUBLISH=1, and never while a README says the package
// is not published yet (npm would show that note).
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const guard = fileURLToPath(new URL("../guard-publish.mjs", import.meta.url))
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function run(readme: string | undefined, allow: boolean): number {
  const dir = mkdtempSync(path.join(tmpdir(), "kervan-guard-"))
  dirs.push(dir)
  if (readme !== undefined) writeFileSync(path.join(dir, "README.md"), readme)
  const env = { ...process.env, KERVAN_ALLOW_PUBLISH: allow ? "1" : "" }
  try {
    execFileSync(process.execPath, [guard], { cwd: dir, env, stdio: "pipe" })
    return 0
  } catch (error) {
    return (error as { status: number }).status
  }
}

describe("the publish guard", () => {
  it("refuses unless publishing is explicitly allowed", () => {
    expect(run("# pkg\n", false)).toBe(1)
    expect(run("# pkg\n", true)).toBe(0)
  })

  it("refuses while the README still says the package is not published", () => {
    expect(run("# pkg\n\n> **Not published yet.** Soon.\n", true)).toBe(1)
  })
})
