// The screenshot leak scanner (scripts/site/leaks.mjs), and that `pnpm site:screenshots` cannot
// write a picture without it.
import { readFileSync } from "node:fs"
import os from "node:os"
import { describe, expect, it } from "vitest"
import { assertNoLeaks, findLeaks, machineSecrets } from "../site/leaks.mjs"

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")

describe("the screenshot leak scanner", () => {
  it("passes the demo data the pictures show", () => {
    const demo = [
      "Ops Team ops@example.test",
      "maya@example.test kerem@example.test",
      "http://studio.example.test:4310/s/2f0c1a9e-0b7e-4c41-9d0f-6a4b3e1f2c55/mcp",
      "Authorization: Bearer kvn_EXAMPLE-KEY-shown-once-in-Studio",
      "127.0.0.1 · 203.0.113.24 · 198.51.100.7 · 192.0.2.10",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0.0.0 Safari/537.36",
      "security@getkervan.dev",
      "ISSUES_TOKEN · WEBHOOK_SIGNING_KEY · api.issues.example.com:443",
    ].join("\n")
    expect(findLeaks(demo, [])).toEqual([])
  })

  it.each([
    ["a real API key", `Bearer kvn_${"A".repeat(43)}`, "an API key"],
    ["a playground token", `kvp_${"b".repeat(30)}.sig`, "a playground token"],
    ["a GitHub token", `ghp_${"x".repeat(36)}`, "a GitHub token"],
    ["an sk- key", `sk-${"q".repeat(40)}`, "an sk- key"],
    ["an AWS key", "AKIAABCDEFGHIJKLMNOP", "an AWS access key"],
    ["a private key", "-----BEGIN OPENSSH PRIVATE KEY-----", "a private key"],
    ["a real email address", "someone@gmail.com", "an email address"],
    ["a private network address", "http://10.0.0.5:4310/", "an IP address"],
    ["a public address", "seen from 8.8.8.8", "an IP address"],
    ["a Windows home folder", "C:\\Users\\someone\\kervan", "a home folder path"],
    ["a POSIX home folder", "/home/someone/kervan", "a home folder path"],
    ["a macOS home folder", "/Users/someone/kervan", "a home folder path"],
  ])("finds %s", (_name, text, expected) => {
    expect(findLeaks(text, [])).toEqual([expect.stringContaining(expected)])
  })

  it("finds the run's own values (setup token, master key, temp folder), in any case and either slash", () => {
    const secrets = ["SetupToken-1234567890", "C:\\Temp\\kervan-site-shots-abc"]
    expect(findLeaks("token: setuptoken-1234567890", secrets)).toHaveLength(1)
    expect(findLeaks("data in c:/temp/kervan-site-shots-abc/studio.db", secrets)).toHaveLength(1)
    expect(findLeaks("nothing here", secrets)).toEqual([])
  })

  it("knows this machine's name, home and temporary folders", () => {
    const secrets = machineSecrets(["abc", "run-value-1234"])
    expect(secrets).toEqual(
      expect.arrayContaining([os.hostname(), os.homedir(), os.tmpdir(), "run-value-1234"]),
    )
    // Short values would match ordinary words: they are left out.
    expect(secrets).not.toContain("abc")
    expect(findLeaks(`saved to ${os.tmpdir()}`, secrets).length).toBeGreaterThan(0)
  })

  it("never puts the leaked value in its message", () => {
    const key = `kvn_${"Z".repeat(43)}`
    expect(() => assertNoLeaks(`key ${key}`, [], "keys page")).toThrow(
      /Refusing to capture keys page: it shows an API key/,
    )
    try {
      assertNoLeaks(`key ${key}`, [], "keys page")
    } catch (error) {
      expect(String(error)).not.toContain(key)
    }
  })
})

describe("pnpm site:screenshots", () => {
  const source = read("scripts/site/screenshots.mjs")

  it("writes pictures only through capture(), which scans the page first", () => {
    // One screenshot call and one image write in the whole script, both inside capture().
    expect(source.match(/\.screenshot\(/g)).toHaveLength(1)
    expect(source.match(/writeFileSync\(/g)).toHaveLength(1)
    const capture = /async function capture\([\s\S]*?\n}\n/.exec(source)?.[0] ?? ""
    expect(capture).toContain(".screenshot(")
    expect(capture).toContain("writeFileSync(")
    // The scan comes before the screenshot, for each theme.
    const scan = capture.indexOf("assertNoLeaks(await visibleText(page)")
    expect(scan).toBeGreaterThan(0)
    expect(scan).toBeLessThan(capture.indexOf(".screenshot("))
  })

  it("scans for the run's setup token, master key, password and temporary folder", () => {
    expect(source).toMatch(/machineSecrets\(\[studio\.token, masterKey, PASSWORD, temp\]\)/)
  })

  it("removes its temporary data folder", () => {
    expect(source).toMatch(/rmSync\(temp, \{ recursive: true, force: true\b/)
  })
})
