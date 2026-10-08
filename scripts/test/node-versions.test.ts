// One Node.js range for everything that runs Kervan's code as a program: the CLI, `npm create
// kervan`, the generated project and Studio. It is `engines` in the root package.json: the oldest
// release of each line the whole test suite has passed on (22.17.1 and 24.15 did not: TypeScript
// needs 22.18 in the framework's tests, and 24.x before 24.21 crashes on Windows). The libraries
// keep `>=22` on purpose: who uses them chooses their own Node.js (docs/REVIEW-NOTES.md).
// This test keeps every package.json, the version checks and the documents on that range.
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as studio from "../../apps/studio/src/node-version.js"
import * as cli from "../../packages/cli/src/node-version.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const read = (file: string) => readFileSync(path.join(root, file), "utf8")
const enginesOf = (file: string) =>
  (JSON.parse(read(file)) as { engines?: { node?: string } }).engines?.node

const RANGE = enginesOf("package.json") ?? ""
const PHRASE = cli.describeEngines(RANGE)

describe("the supported Node.js range", () => {
  it("is the root package.json's engines", () => {
    expect(RANGE).toBe("^22.23.3 || >=24.21.0")
    expect(PHRASE).toBe("22.23.3 or a later 22.x, or 24.21.0 or later")
  })

  it("is every runtime package's engines; the libraries keep >=22", () => {
    for (const file of [
      "apps/studio/package.json",
      "packages/cli/package.json",
      "packages/create-kervan/package.json",
    ]) {
      expect(enginesOf(file), file).toBe(RANGE)
    }
    for (const file of [
      "packages/core/package.json",
      "packages/transport/package.json",
      "packages/spec-runtime/package.json",
    ]) {
      expect(enginesOf(file), file).toBe(">=22")
    }
  })

  it("is what the CLI, Studio and the generated project check", () => {
    expect(cli.NODE_ENGINES).toBe(RANGE)
    expect(studio.NODE_ENGINES).toBe(RANGE)
    expect(studio.describeEngines()).toBe(PHRASE)
    expect(read("packages/cli/templates/basic/package.json")).toContain('"node": "{{nodeEngines}}"')
    expect(read("packages/cli/templates/basic/check-node.mjs")).toContain(
      'const engines = "{{nodeEngines}}"',
    )
    // The two checks agree on every version around the floors.
    for (const version of [
      "20.19.0",
      "22.17.1",
      "22.23.2",
      "22.23.3",
      "22.99.0",
      "23.11.0",
      "24.15.0",
      "24.20.9",
      "24.21.0",
      "25.0.0",
    ]) {
      expect(studio.nodeVersionProblem(version) === undefined, version).toBe(
        cli.satisfiesEngines(version),
      )
    }
  })
})

const SKIP = new Set(["node_modules", ".git", "dist", "dist-web", "coverage", ".playwright-mcp"])

function markdown(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP.has(name)) return []
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return markdown(full)
    return name.endsWith(".md") ? [path.relative(root, full).split(path.sep).join("/")] : []
  })
}

describe("documents", () => {
  it("state the range where they say what Node.js is needed", () => {
    for (const file of [
      "README.md",
      "CONTRIBUTING.md",
      "apps/studio/README.md",
      "packages/cli/README.md",
    ]) {
      expect(read(file), file).toContain(PHRASE)
    }
  })

  it('name no other minimum ("22.18+", "24.15.0 or later", ...)', () => {
    // CLAUDE.md is the project's decision log: it keeps older values as history.
    const files = markdown(root).filter((file) => file !== "CLAUDE.md")
    const allowed = new Set(["22.23.3", "24.21.0", "24.21"])
    const stale: string[] = []
    for (const file of files) {
      const text = read(file)
      for (const match of text.matchAll(
        /\b(\d{2}\.\d{1,2}(?:\.\d+)?)(?:\+| or later| or newer| or a later)/g,
      )) {
        if (!allowed.has(match[1] as string)) stale.push(`${file}: ${match[0]}`)
      }
    }
    expect(stale).toEqual([])
  })
})
