import { describe, expect, it } from "vitest"

// The 0.1 public API. Changing this list is an API change: update docs/API.md with it.
describe("@kervan/spec-runtime public API", () => {
  it("exports exactly these values", async () => {
    expect(Object.keys(await import("../src/index.js")).sort()).toEqual([
      "HTTP_DEFAULTS",
      "LookupGate",
      "NetworkPolicyError",
      "REDACTED",
      "SCHEMA_LIMITS",
      "SPEC_LIMITS",
      "SecretError",
      "SecretVault",
      "SpecLoadError",
      "applySpec",
      "envSecrets",
      "formatIssue",
      "httpTool",
      "loadSpec",
      "specJsonSchema",
    ])
  })
})
