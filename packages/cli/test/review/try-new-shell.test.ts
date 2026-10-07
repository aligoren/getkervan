// Security review (release, CLI on Windows): `pnpm try:new <dir>` runs npm/pnpm through cmd.exe
// on Windows, as one command line. Every argument is quoted, so a path with "&" (a folder like
// "R&D", or the typed <dir>) stays one argument instead of starting a second command.
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const calls: { command: string; options: { shell?: boolean } }[] = []
vi.mock("node:child_process", () => ({
  // spawnSync(line, options) through the shell, spawnSync(command, args, options) otherwise.
  spawnSync: (command: string, second: unknown, third: { shell?: boolean } = {}) => {
    const options = Array.isArray(second) ? third : (second as { shell?: boolean })
    calls.push({ command, options })
    return { status: 0 }
  },
}))

const platform = Object.getOwnPropertyDescriptor(process, "platform")
const dirs: string[] = []
beforeEach(() => {
  calls.length = 0
  // The script decides on process.platform; check its Windows branch on every OS.
  Object.defineProperty(process, "platform", { value: "win32" })
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  if (platform) Object.defineProperty(process, "platform", platform)
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** cmd.exe operators outside double quotes (where cmd.exe acts on them). */
function unquotedOperators(line: string): string[] {
  const found: string[] = []
  let quoted = false
  for (const character of line) {
    if (character === '"') quoted = !quoted
    else if (!quoted && "&|<>^".includes(character)) found.push(character)
  }
  return found
}

describe("try:new on Windows", () => {
  it("keeps a target path with & in it a single argument", async () => {
    const parent = mkdtempSync(path.join(os.tmpdir(), "kervan-review-R&D-"))
    dirs.push(parent)
    const { main } = await import("../../../../scripts/try-new.mjs")
    expect(main(["project"], parent)).toBe(0)
    const shellLines = calls
      .filter((call) => call.options.shell === true)
      .map((call) => call.command)
    expect(shellLines.length).toBeGreaterThan(0)
    // Unquoted, cmd.exe would run "D-xxxx\project\.kervan-tarballs" as a second command.
    expect(shellLines.filter((line) => unquotedOperators(line).length > 0)).toEqual([])
  })
})
