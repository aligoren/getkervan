// Dependabot's configuration: weekly, grouped updates after a week's cooldown, and the packages that
// are updated by hand (Monaco and monaco-yaml, pinned together; @types/node, no major updates).
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
// The repository root has no yaml dependency of its own; spec-runtime's is the same parser.
const YAML = createRequire(path.join(root, "packages/spec-runtime/package.json"))("yaml") as {
  parse(text: string): unknown
}

interface Update {
  "package-ecosystem": string
  cooldown?: { "default-days"?: number }
  ignore?: { "dependency-name": string; "update-types"?: string[]; versions?: string[] }[]
  groups?: Record<string, { "applies-to"?: string; "update-types"?: string[] }>
}
const config = YAML.parse(readFileSync(path.join(root, ".github/dependabot.yml"), "utf8")) as {
  version: number
  updates: Update[]
}
const npm = config.updates.find((update) => update["package-ecosystem"] === "npm")

describe("dependabot.yml", () => {
  it("keeps every ecosystem weekly-grouped behind a seven-day cooldown", () => {
    expect(config.version).toBe(2)
    for (const update of config.updates) {
      expect(update.cooldown?.["default-days"], update["package-ecosystem"]).toBe(7)
    }
    expect(npm?.groups?.["npm-minor-and-patch"]).toMatchObject({
      "applies-to": "version-updates",
      "update-types": ["minor", "patch"],
    })
    expect(npm?.groups?.["npm-major"]).toMatchObject({
      "applies-to": "version-updates",
      "update-types": ["major"],
    })
  })

  it("leaves Monaco and monaco-yaml alone entirely, and @types/node's major versions", () => {
    const ignore = npm?.ignore ?? []
    // No versions or update types: every update of the pinned pair is held back.
    expect(ignore).toContainEqual({ "dependency-name": "monaco-editor" })
    expect(ignore).toContainEqual({ "dependency-name": "monaco-yaml" })
    expect(ignore).toContainEqual({
      "dependency-name": "@types/node",
      "update-types": ["version-update:semver-major"],
    })
  })
})
