import { mkdtempSync, rmSync } from "node:fs"
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

  it("forwards to Studio's command line when it is installed", async () => {
    const { io, out } = capture(studioDir)
    expect(await run(["studio", "--help"], io)).toBe(0)
    expect(out.join("\n")).toContain("Usage: kervan-studio <command>")
  })
})
