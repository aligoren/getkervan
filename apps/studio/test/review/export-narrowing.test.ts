// Security review (phase 4a): the export writes Studio's bindings (narrowed by the spec), never
// values, and never a host Studio does not allow. Every test asserts the secure behavior.
import { loadSpec, SpecLoadError } from "@kervan/spec-runtime"
import { describe, expect, it } from "vitest"
import { ExportError, exportSpec } from "../../src/export.js"
import type { SecretBinding } from "../../src/secrets.js"

const binding = (allowedHosts: string[]): SecretBinding[] => [
  { name: "API_KEY", allowedHosts, updatedAt: 0 },
]

const text = (secrets: string, url = "https://bound.test/x") => `specVersion: 1
name: e
version: 0.0.0
secrets: ${secrets}
tools:
  - name: call
    description: d
    http: { url: "${url}", headers: { X-K: "{{secrets.API_KEY}}" } }
    output: { select: "@" }
`

/** The hosts the exported file lets API_KEY go to (as `kervan run` would read them). */
async function exportedHosts(out: string, url = "https://bound.test/x"): Promise<string[]> {
  const hosts = new Set<string>()
  const source = {
    get: (_name: string, context?: { host: string }) => {
      if (context) hosts.add(context.host)
      return "value-long-enough"
    },
  }
  try {
    const loaded = await loadSpec(out, { secrets: source })
    const entry = loaded.spec.secrets?.find((s) => typeof s !== "string" && s.name === "API_KEY")
    return typeof entry === "object" ? entry.hosts : []
  } catch (error) {
    if (error instanceof SpecLoadError) return [`error: ${url}`]
    throw error
  }
}

const exportOrError = (yaml: string, bindings: SecretBinding[]) => {
  try {
    return exportSpec(yaml, bindings)
  } catch (error) {
    if (error instanceof ExportError) return error
    throw error
  }
}

describe("review: export narrows, never widens", () => {
  it("compares the spec's hosts with Studio's case-insensitively", async () => {
    const out = exportOrError(
      text("[{ name: API_KEY, hosts: [BOUND.TEST, other.test] }]"),
      binding(["bound.test"]),
    )
    expect(typeof out).toBe("string")
    expect(await exportedHosts(out as string)).toEqual(["bound.test"])
  })

  it("never writes a host only the spec lists", async () => {
    for (const secrets of [
      "[{ name: API_KEY, hosts: [attacker.test] }]",
      "[{ name: API_KEY, hosts: [bound.test., attacker.test] }]",
      '[{ name: API_KEY, hosts: ["bound.test", "attacker.test"] }]',
      "[API_KEY]",
    ]) {
      const out = exportOrError(text(secrets), binding(["bound.test"]))
      if (out instanceof ExportError) continue
      const hosts = await exportedHosts(out)
      expect(
        hosts.filter((h) => h !== "bound.test"),
        secrets,
      ).toEqual([])
    }
  })

  it("refuses or narrows a hosts list given through an alias", async () => {
    const yaml = `specVersion: 1
name: e
version: 0.0.0
description: &h attacker.test
secrets: [{ name: API_KEY, hosts: [bound.test, *h] }]
tools:
  - name: call
    description: d
    http: { url: "https://bound.test/x", headers: { X-K: "{{secrets.API_KEY}}" } }
    output: { select: "@" }
`
    const out = exportOrError(yaml, binding(["bound.test"]))
    if (!(out instanceof ExportError)) {
      expect(await exportedHosts(out)).toEqual(["bound.test"])
    }
  })

  it("never writes a secret value, whatever the binding names contain", () => {
    const out = exportOrError(text("[API_KEY]"), binding(["bound.test"]))
    expect(String(out)).not.toContain("value")
  })
})
