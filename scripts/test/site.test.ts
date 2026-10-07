// The static website in site/: its schema copy, its security.txt, and the spec it shows.
import { existsSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { loadSpec } from "../../packages/spec-runtime/src/index.js"
import { checkSecurityTxt, exitCode, securityTxtFields } from "../check-site.mjs"

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")

describe("the website", () => {
  it("serves an exact copy of the package's editor schema (run `pnpm site:schema`)", () => {
    const source = read("packages/spec-runtime/schema/kervan.schema.json")
    expect(read("site/schema/v1.json")).toBe(source)
    // The copy is served at the address the schema names itself by.
    expect(JSON.parse(source).$id).toMatch(/\/schema\/v1\.json$/)
  })

  it("has a well-formed security.txt (RFC 9116)", () => {
    const fields = securityTxtFields(read("site/.well-known/security.txt"))
    expect([...fields.keys()].sort()).toEqual(
      ["Canonical", "Contact", "Expires", "Preferred-Languages"].sort(),
    )
    expect(fields.get("Contact")).toMatch(/^mailto:security@/)
    expect(fields.get("Preferred-Languages")).toBe("en, tr")
    expect(fields.get("Canonical")).toMatch(/^https:\/\/[^/]+\/\.well-known\/security\.txt$/)
    // A full ISO 8601 date-time in UTC. Whether it is still in the future is `pnpm check:site`'s
    // job, not this suite's: the suite must not turn red on its own as time passes.
    expect(fields.get("Expires")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
    expect(Number.isNaN(Date.parse(fields.get("Expires") ?? ""))).toBe(false)
  })

  it("check:site fails on an expired date and warns 30 days ahead (fixed clock)", () => {
    const now = Date.parse("2027-01-01T00:00:00.000Z")
    const at = (expires: string) =>
      checkSecurityTxt(`Contact: mailto:x\nExpires: ${expires}\n`, now)
    expect(at("2026-12-31T23:59:59.000Z").errors).toEqual([
      expect.stringContaining("security.txt expired"),
    ])
    expect(at("2027-01-01T00:00:00.000Z").errors).toHaveLength(1)
    expect(at("2027-01-20T00:00:00.000Z")).toEqual({
      errors: [],
      warnings: ["security.txt expires in 19 day(s): renew Expires soon."],
    })
    expect(at("2027-06-01T00:00:00.000Z")).toEqual({ errors: [], warnings: [] })
    expect(at("2028-06-01T00:00:00.000Z").warnings).toEqual([
      expect.stringContaining("more than a year ahead"),
    ])
    expect(at("someday").errors).toEqual(["security.txt has no valid Expires date."])
  })

  it("loads nothing from other sites and runs no script", () => {
    const html = read("site/index.html")
    expect(html).not.toMatch(/<script|<link[^>]+stylesheet|@import|@font-face/i)
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//i)
  })

  it("has no link that leads nowhere: only mail, in-page anchors and files it serves", () => {
    const html = read("site/index.html")
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? "")
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]))
    for (const href of hrefs) {
      if (href.startsWith("mailto:")) expect(href).toMatch(/^mailto:(hello|security)@/)
      else if (href.startsWith("#")) expect(ids.has(href.slice(1)), href).toBe(true)
      else if (href.startsWith("data:")) continue
      else if (href === "/") continue
      else expect(existsSync(new URL(`../../site${href}`, import.meta.url)), href).toBe(true)
    }
  })

  it("does not present anything unpublished as available", () => {
    const html = read("site/index.html")
    expect(html).toMatch(/not published yet/i)
    // Install commands appear only in a section marked "Coming soon".
    const start = html.slice(html.indexOf('id="start"'), html.indexOf('id="contact"'))
    expect(start).toContain("Coming soon")
    expect(html.slice(0, html.indexOf('id="start"'))).not.toMatch(/npm create|npx kervan/)
    expect(html).not.toMatch(/github\.com|npmjs\.com/i)
  })

  it("shows a spec that loads", async () => {
    const html = read("site/index.html")
    const example = /<pre><code>(specVersion: 1[\s\S]*?)<\/code><\/pre>/.exec(html)?.[1]
    expect(example).toBeDefined()
    const loaded = await loadSpec(example ?? "", { secrets: { get: () => undefined } })
    expect(loaded.tools.map((tool) => tool.name)).toEqual(["get_daily_forecast"])
  })
})

describe("check:site's exit code", () => {
  it("fails on errors, and with --strict (the weekly CI job) on warnings too", () => {
    const none = { errors: [], warnings: [] }
    const warned = { errors: [], warnings: ["security.txt expires in 9 day(s)"] }
    const failed = { errors: ["security.txt expired"], warnings: [] }
    expect([exitCode(none, false), exitCode(warned, false), exitCode(failed, false)]).toEqual([
      0, 0, 1,
    ])
    expect([exitCode(none, true), exitCode(warned, true), exitCode(failed, true)]).toEqual([
      0, 1, 1,
    ])
  })
})
