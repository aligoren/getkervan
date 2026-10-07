// Security review (release, surfaces): checks that held up, kept as regression tests.
import { loadSpec } from "@kervan/spec-runtime"
import { describe, expect, it } from "vitest"
import { clientIp } from "../../src/client-ip.js"
import { studioLogger } from "../../src/logger.js"

const ESC = String.fromCodePoint(0x1b)

describe("Studio's console log", () => {
  it("writes data (errors, objects) as one escaped line: no raw control characters or breaks", () => {
    const lines: string[] = []
    const logger = studioLogger((text) => text.replaceAll("sk-secret-value-1234", "[redacted]"), {
      write: (line) => lines.push(line),
    })
    logger.warn("Could not record a tool call", {
      tool: `x${ESC}[2K\nFAKE`,
      key: "sk-secret-value-1234",
    })
    expect(lines).toHaveLength(1)
    // No control character but the tab.
    expect(
      [...(lines[0] ?? "")].filter(
        (c) => (c.codePointAt(0) ?? 0) < 0x20 && c.codePointAt(0) !== 0x09,
      ),
    ).toEqual([])
    expect(lines[0]).not.toContain("sk-secret-value-1234")
  })
})

describe("client addresses that reach the audit log", () => {
  it("are IP addresses only, whatever X-Forwarded-For holds", () => {
    for (const forged of [
      `<img src=x>`,
      `1.2.3.4${ESC}[2K`,
      "fe80::1%<b>",
      "1.2.3.4\nlogin.success",
      String.fromCodePoint(0x202e),
    ]) {
      expect(clientIp("10.0.0.1", forged, 1)).toBe("10.0.0.1")
    }
  })
})

describe("names the spec runtime lets through", () => {
  it("tool and secret names are plain ASCII (they reach logs, audit details and clients)", async () => {
    const yaml = (tool: string, secret: string) => `specVersion: 1
name: t
version: "1"
secrets: [${JSON.stringify(secret)}]
tools:
  - name: ${JSON.stringify(tool)}
    description: d
    http:
      url: https://api.example.test/x
      headers: { X-Key: "{{secrets.${secret}}}" }
    output: { select: "@" }
`
    for (const [tool, secret] of [
      [`a${ESC}b`, "KEY_ONE"],
      [`a${String.fromCodePoint(0x202e)}b`, "KEY_ONE"],
      ["a b", "KEY_ONE"],
      ["ok", `KEY${ESC}`],
    ] as const) {
      await expect(
        loadSpec(yaml(tool, secret), { secrets: { get: () => "x".repeat(16) } }),
      ).rejects.toThrow()
    }
  })
})
