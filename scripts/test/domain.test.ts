// The project's domain is for people (docs, contact details, the website) and for naming the editor
// schema. Code never talks to it: no telemetry, no update checks, no remote schemas. This test keeps
// the domain out of every place it could turn into a network request.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const DOMAIN = "getkervan.dev"
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
/** The repository's files: tracked, or new and not ignored (what a commit would add). */
function files(dir: string): string[] {
  const listed = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  )
  return listed
    .split("\0")
    .filter(Boolean)
    .map((file) => path.join(dir, file))
    .filter((full) => existsSync(full) && statSync(full).size < 4_000_000)
}

const mentions = files(root)
  .map((file) => ({ file: path.relative(root, file).split(path.sep).join("/"), text: "" }))
  .map((entry) => ({ ...entry, text: readFileSync(path.join(root, entry.file), "utf8") }))
  .filter((entry) => !entry.text.includes("\u0000") && entry.text.includes(DOMAIN))

/** Where the domain may appear, and (for the schema) on which line. */
function allowed(file: string, text: string): boolean {
  if (file === "scripts/test/domain.test.ts") return true
  if (file.endsWith(".md")) return true
  if (file.startsWith("site/")) return true
  // The scripts that build and check the website name it; they never send it a request.
  if (file === "scripts/check-site.mjs" || file.startsWith("scripts/site/")) return true
  if (/^scripts\/test\/site[\w-]*\.test\.ts$/.test(file)) return true
  // Checks the packages' homepage and documentation links as text; it requests nothing.
  if (file === "scripts/test/repository.test.ts") return true
  if (file === "packages/spec-runtime/scripts/schema-id.mjs") return true
  if (file.endsWith("package.json")) return true
  if (file === "packages/spec-runtime/schema/kervan.schema.json") {
    // Only as the schema's `$id`.
    return text
      .split("\n")
      .filter((line) => line.includes(DOMAIN))
      .every((line) => /^\s*"\$id": "https:\/\/getkervan\.dev\/schema\/v1\.json",$/.test(line))
  }
  return false
}

describe(`the ${DOMAIN} domain`, () => {
  it("is found by this test where it is expected (the check is not blind)", () => {
    const found = mentions.map((entry) => entry.file)
    expect(found).toEqual(
      expect.arrayContaining([
        "SECURITY.md",
        "site/static/.well-known/security.txt",
        "packages/spec-runtime/schema/kervan.schema.json",
      ]),
    )
  })

  it("appears only in docs, the website, contact details and the schema's id", () => {
    const outside = mentions.filter((entry) => !allowed(entry.file, entry.text))
    expect(outside.map((entry) => entry.file)).toEqual([])
  })

  it("never appears in source code (no requests to it at run time)", () => {
    const inSource = mentions.filter((entry) => /(^|\/)src\//.test(entry.file))
    expect(inSource.map((entry) => entry.file)).toEqual([])
  })
})
