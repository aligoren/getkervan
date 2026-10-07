// Every published package is MIT and ships the license text with it: npm takes a LICENSE file only
// from the package's own folder, so each one has a copy of the repository's.
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const license = readFileSync(path.join(root, "LICENSE"), "utf8")
const packages = readdirSync(path.join(root, "packages"))

describe("license", () => {
  it.each(packages)("packages/%s has the repository's LICENSE and says MIT", (name) => {
    const dir = path.join(root, "packages", name)
    expect(readFileSync(path.join(dir, "LICENSE"), "utf8")).toBe(license)
    const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as {
      license?: string
      files?: string[]
    }
    expect(manifest.license).toBe("MIT")
    // `files` must not leave it out (npm adds LICENSE anyway, unless it is excluded).
    expect(
      manifest.files?.some((entry) => /licen[cs]e/i.test(entry) && entry.startsWith("!")),
    ).not.toBe(true)
  })
})
