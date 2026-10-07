// Kervan masks secret values it knows (from secret-looking variable names) and URL passwords,
// nothing else: a UUID in a path, a hash or a long id stays readable, so log paths can be copied.
// (A masked UUID seen in `npm install` output comes from npm's own redaction, not from Kervan:
// `kervan create` passes npm's output through untouched.)
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { collectSecrets, createRedactor } from "../src/dev/redact.js"

const SECRET = "sk-live-0123456789abcdef"

describe("Kervan's redaction", () => {
  const redact = createRedactor(
    collectSecrets({
      OPENAI_API_KEY: SECRET,
      SESSION_ID: "7c1e2f4a-9b3d-4e6f-8a1c-2d3e4f5a6b7c-not",
    }),
  )

  it("leaves UUIDs, hashes and long ids in paths and messages alone", () => {
    const text = [
      "C:\\Users\\dev\\AppData\\Local\\Temp\\build\\7c1e2f4a-9b3d-4e6f-8a1c-2d3e4f5a6b7c\\work\\node.exe",
      "/tmp/build/3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f/log.txt",
      "commit 9d4c2b7e1f0a8c6d5e3b2a1f0e9d8c7b6a5f4e3d",
      "npm-cache/_logs/2026-10-07T16_51_21_354Z-debug-0.log",
    ].join("\n")
    expect(redact(text)).toBe(text)
  })

  it("still masks the secrets it knows and URL passwords", () => {
    expect(redact(`calling with ${SECRET}`)).toBe("calling with [redacted]")
    expect(redact("https://user:hunter22@db.example.com/x")).toBe(
      "https://user:[redacted]@db.example.com/x",
    )
  })

  it("does not filter npm's own install output in `kervan create`", () => {
    const create = readFileSync(new URL("../src/create.ts", import.meta.url), "utf8")
    expect(create).toMatch(/stdio: "inherit"/)
    expect(create).not.toMatch(/createRedactor|collectSecrets/)
  })
})
