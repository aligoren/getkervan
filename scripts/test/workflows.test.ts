// The GitHub workflows stay locked down: every third-party action is pinned to a full commit SHA
// (a tag can be moved to other code), every workflow starts from read-only permissions, and
// publishing runs only by hand, behind the "release" environment's approval.
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.github/workflows")
const workflows = readdirSync(dir)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => ({ name, text: readFileSync(path.join(dir, name), "utf8") }))

describe("workflows", () => {
  it("exist (the checks are not blind)", () => {
    expect(workflows.map((w) => w.name).sort()).toEqual(["ci.yml", "release.yml", "site-check.yml"])
  })

  it.each(workflows)("$name pins every action to a full commit SHA, with its version", (w) => {
    const uses = [...w.text.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/gm)]
    expect(uses.length).toBeGreaterThan(0)
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w.-]+(\/[\w./-]+)?@[0-9a-f]{40}$/)
      expect(rest, ref).toMatch(/#\s*v\d+\.\d+\.\d+/)
    }
  })

  it.each(workflows)("$name starts from read-only permissions", (w) => {
    expect(w.text).toMatch(/^permissions:\n\s+contents: read\n/m)
    // Nothing writes to the repository.
    expect(w.text).not.toMatch(/contents:\s*write|write-all/)
  })

  it("publishes only by hand, after the release environment's approval, with provenance", () => {
    const release = workflows.find((w) => w.name === "release.yml")?.text ?? ""
    const triggers = release.slice(release.indexOf("\non:"), release.indexOf("\npermissions:"))
    expect(triggers).toMatch(/workflow_dispatch:/)
    expect(triggers).not.toMatch(/\b(push|pull_request|schedule|release|workflow_run):/)
    expect(release).toMatch(/^\s+environment: release$/m)
    expect(release).toMatch(/id-token: write/)
    expect(release).toMatch(/npm publish .*--provenance/)
    // The guard runs for every package before anything is published.
    expect(release.indexOf("guard-publish.mjs")).toBeGreaterThan(0)
    expect(release.indexOf("guard-publish.mjs")).toBeLessThan(release.indexOf("npm publish"))
  })

  it("never publish or deploy outside release.yml", () => {
    for (const w of workflows.filter((each) => each.name !== "release.yml")) {
      expect(w.text, w.name).not.toMatch(/npm publish|pnpm publish|id-token/)
    }
  })
})
