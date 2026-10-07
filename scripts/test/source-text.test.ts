// No source file may contain invisible or text-direction characters: a bidi override or a
// zero-width character in code can make it read differently from what runs ("Trojan Source").
// Tests and code that need such characters build them from code points.
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const SKIP = new Set(["node_modules", ".git", "dist", "dist-web", "coverage", ".playwright-mcp"])
const TEXT = /\.(ts|tsx|mts|mjs|js|json|md|css|html|ya?ml|txt|sql)$/

// The same classes as apps/studio/src/display-text.ts: controls other than tab, line feed and
// carriage return; format characters (bidi controls, zero-width characters, ...); line and
// paragraph separators; letters that draw as nothing.
const INVISIBLE = new RegExp(
  `[\\p{Cf}\\p{Zl}\\p{Zp}${String.fromCodePoint(0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x180e)}]|(?![\\t\\n\\r])\\p{Cc}`,
  "u",
)

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return []
    const full = path.join(dir, name)
    const stat = statSync(full)
    if (stat.isDirectory()) return files(full)
    return TEXT.test(name) && stat.size < 4_000_000 ? [full] : []
  })
}

describe("source files", () => {
  it("contain no invisible or text-direction characters", () => {
    const found: string[] = []
    for (const file of files(root)) {
      const lines = readFileSync(file, "utf8").split("\n")
      lines.forEach((line, index) => {
        const match = INVISIBLE.exec(line)
        if (match) {
          const code = (match[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")
          found.push(`${path.relative(root, file)}:${index + 1} U+${code}`)
        }
      })
    }
    expect(found).toEqual([])
  })

  it("would notice one (the check is not blind)", () => {
    expect(INVISIBLE.test(`a${String.fromCodePoint(0x202e)}b`)).toBe(true)
    expect(INVISIBLE.test(`a${String.fromCodePoint(0x200b)}b`)).toBe(true)
    expect(INVISIBLE.test(`a${String.fromCodePoint(0)}b`)).toBe(true)
    expect(INVISIBLE.test("tabs\tand\r\nbreaks are fine")).toBe(false)
  })
})
