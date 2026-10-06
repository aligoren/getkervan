import { describe, expect, it } from "vitest"
import { run } from "../src/index.js"
import {
  type RuntimeInfo,
  supportsTypeStripping,
  typeStrippingProblem,
  windowsLibuvWarning,
} from "../src/node-version.js"

const runtime = (version: string, extra: Partial<RuntimeInfo> = {}): RuntimeInfo => ({
  version,
  platform: "linux",
  typescript: "strip",
  ...extra,
})

describe("supportsTypeStripping", () => {
  it.each([
    ["v20.19.0", false],
    ["v22.17.1", false],
    ["v22.18.0", true],
    ["v22.23.3", true],
    ["v23.5.0", false],
    ["v23.6.0", true],
    ["v24.0.0", true],
    ["v26.10.0", true],
  ])("%s → %s", (version, expected) => {
    expect(supportsTypeStripping(version)).toBe(expected)
  })
})

describe("typeStrippingProblem", () => {
  it("names the required version on old Node.js", () => {
    expect(typeStrippingProblem(runtime("v22.17.1"))).toMatch(/22\.18\.0\+.*v22\.17\.1/)
  })

  it("explains a disabled type stripping", () => {
    expect(typeStrippingProblem(runtime("v24.21.0", { typescript: false }))).toMatch(
      /--no-experimental-strip-types/,
    )
  })

  it("accepts supported runtimes", () => {
    expect(typeStrippingProblem(runtime("v22.18.0"))).toBeUndefined()
  })
})

describe("windowsLibuvWarning", () => {
  it.each([
    ["win32", "v24.15.0", true],
    ["win32", "v24.20.0", true],
    ["win32", "v24.21.0", false],
    ["win32", "v22.23.3", false],
    ["win32", "v26.10.0", false],
    ["linux", "v24.15.0", false],
    ["darwin", "v24.15.0", false],
  ] as const)("%s %s → warn %s", (platform, version, warns) => {
    const warning = windowsLibuvWarning(runtime(version, { platform }))
    expect(warning !== undefined).toBe(warns)
    if (warning) expect(warning).toMatch(/24\.21/)
  })
})

describe("kervan create on old Node.js", () => {
  it("fails with a clear message before doing anything", async () => {
    const out: string[] = []
    const err: string[] = []
    const code = await run(["create", "anything", "--no-install"], {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      runtime: runtime("v22.17.1"),
    })
    expect(code).toBe(1)
    expect(err.join("\n")).toMatch(/Node\.js 22\.18\.0\+/)
    expect(out).toEqual([])
  })
})
