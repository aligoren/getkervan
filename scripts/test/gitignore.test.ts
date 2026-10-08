// What .gitignore keeps out of the repository: secrets (environment files, Studio's master key,
// private keys), Studio's database and its WAL files, build and test output. Checked with git
// itself (`git check-ignore`), so the test sees exactly what a commit would see.
import { execFileSync, spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" })

/** The .gitignore line that decides a path, or undefined when nothing ignores it. */
function rule(file: string): string | undefined {
  const result = spawnSync("git", ["check-ignore", "--no-index", "-v", file], {
    cwd: root,
    encoding: "utf8",
  })
  if (result.status !== 0) return undefined
  // "<source>:<line>:<pattern>\t<path>"
  const [where] = result.stdout.split("\t")
  const pattern = where?.split(":").slice(2).join(":")
  // With -v, a matching exception ("!.env.example") is reported too: the path is not ignored.
  return pattern?.startsWith("!") ? undefined : pattern
}

const IGNORED = [
  ".env",
  ".env.local",
  ".env.studio",
  "examples/spec/.env",
  "apps/studio/.env.production",
  "x.sqlite",
  "x.sqlite-wal",
  "x.sqlite-shm",
  ".kervan-studio/studio.db",
  "apps/studio/.kervan-studio/studio.db-wal",
  "data/studio.db",
  "master.key",
  "tls/server.key",
  "tls/server.pem",
  "node_modules/zod/package.json",
  "packages/core/dist/index.js",
  "packages/core/tsconfig.tsbuildinfo",
  "apps/studio/test-results/trace.zip",
  "playwright-report/index.html",
  "site/public/index.html",
  "site/resources/_gen/x.png",
  "site/.hugo_build.lock",
  "debug.log",
  "anything/package.json",
  "Thumbs.db",
  ".DS_Store",
]

describe(".gitignore", () => {
  it.each(IGNORED)("ignores %s", (file) => {
    expect(rule(file), file).toBeDefined()
  })

  it("keeps documented examples (.env.example) and the sources", () => {
    for (const file of [
      "examples/spec/.env.example",
      "packages/core/src/index.ts",
      "site/content/_index.md",
    ]) {
      expect(rule(file), file).toBeUndefined()
    }
  })

  it("names Studio's master key file in a rule of its own, not only through .env.*", () => {
    expect(rule(".env.studio")).toBe(".env.studio")
  })

  it("ignores no tracked file", () => {
    expect(git("ls-files", "-ci", "--exclude-standard")).toBe("")
  })

  it("tracks no environment file, database, private key or certificate", () => {
    const tracked = git("ls-files").split("\n").filter(Boolean)
    const sensitive = tracked.filter(
      (file) =>
        (/(^|\/)\.env(\.|$)/.test(file) && !file.endsWith(".env.example")) ||
        /\.(sqlite3?|db)(-wal|-shm|-journal)?$/.test(file) ||
        /\.(pem|key|p12|pfx)$/.test(file),
    )
    expect(sensitive).toEqual([])
  })
})
