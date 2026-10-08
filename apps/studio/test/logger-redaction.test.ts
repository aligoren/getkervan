// Studio's logger and unusual secrets. `inspect` escapes some characters its own way (`\x1B`,
// `\'`) and cuts strings at 10,000 characters: had redaction run only on its output, a secret
// with such characters, or a long one, would come out unredacted or as a prefix. Each secret
// below carries a unique marker; no marker may appear in anything the logger writes.
import { randomBytes } from "node:crypto"
import { SecretVault } from "@kervan/spec-runtime"
import { describe, expect, it } from "vitest"
import { studioLogger } from "../src/logger.js"

const cp = (...points: number[]) => String.fromCodePoint(...points)

/** Secrets with what `inspect` or JSON escape differently, each with its own marker. */
const SECRETS: Record<string, string> = {
  long: `MARKlong01-${randomBytes(9_000).toString("base64")}`,
  escape: `MARKesc001${cp(0x1b)}[31mred`,
  nul: `MARKnul001${cp(0)}after`,
  del: `MARKdel001${cp(0x7f)}after`,
  c1: `MARKc10001${cp(0x85)}${cp(0x9b)}after`,
  bell: `MARKbel001${cp(7)}${cp(8)}${cp(0x0b)}${cp(0x0c)}after`,
  quotes: 'MARKquot01 it\'s "quoted" `ticked`',
  multiline: "MARKline01\nsecond line\r\nthird\tcolumn",
  backslash: "MARKbsl001\\n not a newline \\x1B",
  unicode: `MARKuni001-şifre-${cp(0x5bc6, 0x7801)}-${cp(0x1f511)}-${cp(0x10ffff)}`,
  separators: `MARKsep001${cp(0x2028)}${cp(0x2029)}${cp(0x200b)}${cp(0x202e)}`,
}
const MARKERS = Object.values(SECRETS).map((value) => value.slice(0, 10))

function setup() {
  const vault = new SecretVault()
  for (const [name, value] of Object.entries(SECRETS)) vault.add(name.toUpperCase(), value)
  const lines: string[] = []
  const logger = studioLogger((text) => vault.redact(text), {
    level: "debug",
    write: (line) => lines.push(line),
  })
  return { logger, lines }
}

function expectNoMarker(lines: string[]) {
  const output = lines.join("\n")
  for (const marker of MARKERS) expect(output).not.toContain(marker)
  // Nor a long piece of the long secret (a prefix left by truncation).
  const long = SECRETS.long ?? ""
  for (let at = 0; at + 40 <= long.length; at += 400) {
    expect(output).not.toContain(long.slice(at, at + 40))
  }
}

describe("Studio's logger with unusual secrets", () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    it(`redacts the ${name} secret wherever it is in the entry`, () => {
      const { logger, lines } = setup()
      logger.info(`in the message ${secret} end`)
      logger.warn("a string", secret)
      logger.warn("nested", { a: { b: { c: [secret, { d: secret }] } }, [secret]: "as a key" })
      logger.error("an error", new Error(`failed with ${secret}`))
      const withCause = new Error("outer", { cause: new Error(`inner ${secret}`) })
      Object.assign(withCause, { code: "E_TEST", detail: secret, [`k${secret}`]: 1 })
      logger.error("an error with a cause and fields", withCause)
      logger.debug("a map and a set", { map: new Map([[secret, secret]]), set: new Set([secret]) })
      logger.info("a long string around it", `${"x".repeat(12_000)}${secret}${"y".repeat(50)}`)
      logger.info("bytes", { buffer: Buffer.from(secret), view: new TextEncoder().encode(secret) })
      expect(lines.length).toBe(8)
      expectNoMarker(lines)
    })
  }

  it("still shows what is not secret", () => {
    const { logger, lines } = setup()
    logger.error("API request failed (ref: 1234)", Object.assign(new Error("boom"), { code: 42 }))
    logger.info("data", { tool: "get_weather", count: 3, nested: { ok: true } })
    expect(lines[0]).toContain("API request failed (ref: 1234)")
    expect(lines[0]).toContain("boom")
    expect(lines[0]).toContain("42")
    expect(lines[1]).toContain("get_weather")
    expect(lines[1]).toContain("count: 3")
  })

  it("survives cycles and deep nesting", () => {
    const { logger, lines } = setup()
    const cycle: Record<string, unknown> = { name: SECRETS.quotes }
    cycle.self = cycle
    let deep: Record<string, unknown> = { leaf: SECRETS.escape }
    for (let i = 0; i < 50; i++) deep = { deeper: deep }
    logger.info("cycle", cycle)
    logger.info("deep", deep)
    expect(lines).toHaveLength(2)
    expectNoMarker(lines)
  })
})
