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

  it("publishes from main only, one run at a time, after test:pack, never a pre-release as latest", () => {
    const release = workflows.find((w) => w.name === "release.yml")?.text ?? ""
    expect(release).toMatch(/^\s+if: github\.ref == 'refs\/heads\/main'$/m)
    expect(release).toMatch(/^concurrency:\n\s+group: release\n\s+cancel-in-progress: false$/m)
    const publish = release.indexOf("npm publish")
    for (const step of ["pnpm test:pack", "is a pre-release: publish it under next"]) {
      expect(release.indexOf(step), step).toBeGreaterThan(0)
      expect(release.indexOf(step), step).toBeLessThan(publish)
    }
    // A rerun skips what the first run published instead of failing on it.
    expect(release).toMatch(/npm view "\$name@\$version" version[^\n]*\n[^\n]*\n\s+continue/)
  })

  it("CI installs the packed packages too", () => {
    const ci = workflows.find((w) => w.name === "ci.yml")?.text ?? ""
    expect(ci).toMatch(/^\s+- run: pnpm test:pack$/m)
  })

  it("CI runs the shell quoting tests: zsh installed on Linux, every shell required", () => {
    const ci = workflows.find((w) => w.name === "ci.yml")?.text ?? ""
    expect(ci).toMatch(/if: runner\.os == 'Linux'\n\s+run: .*apt-get install .*\bzsh\b/)
    expect(ci).toMatch(
      /- run: pnpm test\n\s+env:\n\s+KERVAN_REQUIRE_SHELLS: \$\{\{ runner\.os == 'Linux' && 'bash,zsh' \|\| 'bash,powershell' \}\}/,
    )
  })

  it.each(workflows)("$name pins Ubuntu to 24.04 (a new image is a deliberate change)", (w) => {
    // ubuntu-latest moves to a new release on GitHub's schedule; Playwright's system packages
    // and the Hugo install are checked against one image (docs/RELEASING.md, "Runner images").
    expect(w.text).not.toMatch(/ubuntu-latest/)
    const runners = [
      ...[...w.text.matchAll(/^\s+runs-on: (\S+)$/gm)].map((match) => match[1]),
      ...[...w.text.matchAll(/^\s+os: \[([^\]]+)\]$/gm)].flatMap((match) =>
        (match[1] ?? "").split(",").map((os) => os.trim()),
      ),
      // `runs-on: ${{ matrix.os }}` names no runner itself: the matrix's `os` list does.
    ].filter((runner) => !runner?.startsWith("${{"))
    expect(runners.length).toBeGreaterThan(0)
    for (const runner of runners) expect(runner, w.name).toMatch(/^(ubuntu-24\.04|windows-latest)$/)
  })

  it("never publish or deploy outside release.yml", () => {
    for (const w of workflows.filter((each) => each.name !== "release.yml")) {
      expect(w.text, w.name).not.toMatch(/npm publish|pnpm publish|id-token/)
    }
  })
})
