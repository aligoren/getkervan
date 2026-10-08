// The website's sources (site/): its schema copy, its security.txt, the fonts and design tokens it
// shares with Studio, the Hugo version pin, and check:site's date logic.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { checkSecurityTxt, exitCode, securityTxtFields } from "../check-site.mjs"
import { hugoProblem, parseHugoVersion, pinnedHugoVersion } from "../site/build.mjs"

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8")
const bytes = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url))

describe("the website's files", () => {
  it("serves an exact copy of the package's editor schema (run `pnpm site:schema`)", () => {
    const source = read("packages/spec-runtime/schema/kervan.schema.json")
    expect(read("site/static/schema/v1.json")).toBe(source)
    // The copy is served at the address the schema names itself by.
    expect(JSON.parse(source).$id).toBe("https://getkervan.dev/schema/v1.json")
  })

  it("has a well-formed security.txt (RFC 9116)", () => {
    const fields = securityTxtFields(read("site/static/.well-known/security.txt"))
    expect([...fields.keys()].sort()).toEqual(
      ["Canonical", "Contact", "Expires", "Policy", "Preferred-Languages"].sort(),
    )
    expect(fields.get("Contact")).toBe("mailto:security@getkervan.dev")
    // The policy is SECURITY.md as GitHub shows it, in the repository the root package.json names.
    const repository = /^git\+(https:\/\/github\.com\/[\w.-]+\/[\w.-]+)\.git$/.exec(
      JSON.parse(read("package.json")).repository.url,
    )?.[1]
    expect(repository).toBeDefined()
    expect(fields.get("Policy")).toBe(`${repository}/security/policy`)
    expect(fields.get("Preferred-Languages")).toBe("en, tr")
    expect(fields.get("Canonical")).toBe("https://getkervan.dev/.well-known/security.txt")
    // A full ISO 8601 date-time in UTC. Whether it is still in the future is `pnpm check:site`'s
    // job, not this suite's: the suite must not turn red on its own as time passes.
    expect(fields.get("Expires")).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/)
  })

  it("self-hosts Inter: the same Latin subset Studio uses, with its license", () => {
    const shipped = bytes("site/static/fonts/inter-latin-wght-normal.woff2")
    const source = bytes(
      "apps/studio/node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2",
    )
    expect(shipped.equals(source)).toBe(true)
    expect(read("site/static/fonts/OFL.txt")).toMatch(/SIL Open Font License/)
  })

  it("contact addresses match SECURITY.md and CODE_OF_CONDUCT.md", () => {
    const config = read("site/hugo.toml")
    expect(config).toContain('security = "security@getkervan.dev"')
    expect(config).toContain('hello = "hello@getkervan.dev"')
    expect(config).toContain('conduct = "conduct@getkervan.dev"')
    expect(read("SECURITY.md")).toContain("security@getkervan.dev")
    expect(read("CODE_OF_CONDUCT.md")).toContain("conduct@getkervan.dev")
  })
})

describe("the Hugo version", () => {
  it("is pinned in one place and recognized in `hugo version` output", () => {
    expect(pinnedHugoVersion()).toMatch(/^\d+\.\d+\.\d+$/)
    const line = "hugo v0.167.0-3fff6fb5c+extended windows/amd64 BuildDate=2026-09-28T14:50:38Z"
    expect(parseHugoVersion(line)).toBe("0.167.0")
    expect(hugoProblem(line, "0.167.0")).toBeUndefined()
    expect(hugoProblem("hugo v0.150.1 linux/amd64", "0.167.0")).toMatch(
      /Hugo 0\.150\.1 is installed, the site needs 0\.167\.0/,
    )
    expect(hugoProblem(undefined, "0.167.0")).toMatch(
      /^Hugo was not found\. Install Hugo 0\.167\.0/,
    )
  })

  it("has a checksum for each Linux download the install script may fetch", () => {
    const version = pinnedHugoVersion()
    const sums = read("site/hugo-checksums.txt")
    for (const arch of ["amd64", "arm64"]) {
      expect(sums).toMatch(
        new RegExp(
          `^[0-9a-f]{64}  hugo_${version.replaceAll(".", "\\.")}_linux-${arch}\\.tar\\.gz$`,
          "m",
        ),
      )
    }
  })
})

describe("check:site's dates", () => {
  it("fails on an expired date and warns 30 days ahead (fixed clock)", () => {
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

  it("fails on errors, and with --strict (CI, release day) on warnings too", () => {
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
