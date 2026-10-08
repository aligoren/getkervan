// `pnpm verify:published` (scripts/verify-published.mjs) checks the registry after a release. It
// needs the network and a real release, so this suite tests what it decides with made-up registry
// answers: a wrong version, a missing package, a wrong dist-tag, wrong metadata, a tarball that
// is not the one the registry describes, and arguments that must never reach a command.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  expectedManifests,
  integrityProblems,
  parseArgs,
  viewProblems,
} from "../verify-published.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const readManifest = (dir: string) =>
  JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8"))
const VERSION = "0.1.0-rc.1"
const expected = expectedManifests(VERSION, readManifest)
const core = expected.find((each) => each.name === "@kervan/core") ?? expected[0]
if (!core) throw new Error("no @kervan/core")

const integrity = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`

/** What the registry would answer for @kervan/core after a good release. */
const goodView = () => ({
  name: "@kervan/core",
  version: VERSION,
  "dist-tags": { next: VERSION, latest: VERSION },
  license: core.license,
  engines: { node: core.engines },
  repository: { ...core.repository },
  dist: { integrity: integrity(Buffer.from("tarball")) },
})

describe("the expected metadata", () => {
  it("comes from the repository's package.json files, for all five packages", () => {
    expect(expected.map((each) => each.name)).toEqual([
      "@kervan/core",
      "@kervan/transport",
      "@kervan/spec-runtime",
      "kervan",
      "create-kervan",
    ])
    expect(core).toMatchObject({
      version: VERSION,
      license: "MIT",
      engines: ">=22",
      repository: { type: "git", directory: "packages/core" },
    })
  })
})

describe("the registry's answer", () => {
  it("passes when everything matches", () => {
    expect(viewProblems(core, goodView(), "next")).toEqual([])
  })

  it.each([
    ["a missing package", undefined, /is not on the registry/],
    [
      "another version",
      { ...goodView(), version: "0.1.0-rc.2" },
      /version 0\.1\.0-rc\.2, expected/,
    ],
    [
      "the tag on another version",
      { ...goodView(), "dist-tags": { next: "0.0.9" } },
      /dist-tag next is 0\.0\.9/,
    ],
    [
      "no such tag",
      { ...goodView(), "dist-tags": { latest: VERSION } },
      /dist-tag next is not set/,
    ],
    ["another license", { ...goodView(), license: "ISC" }, /license ISC/],
    ["other engines", { ...goodView(), engines: { node: ">=18" } }, /engines\.node >=18/],
    [
      "another repository",
      { ...goodView(), repository: { ...core.repository, directory: "packages/cli" } },
      /repository/,
    ],
    ["no integrity", { ...goodView(), dist: {} }, /no sha512 integrity/],
    ["another package", { ...goodView(), name: "kervan" }, /answered for kervan/],
  ])("fails on %s", (_, viewed, problem) => {
    expect(viewProblems(core, viewed, "next")).toEqual([expect.stringMatching(problem)])
  })

  it("checks the tag it is asked about", () => {
    const viewed = { ...goodView(), "dist-tags": { next: VERSION } }
    expect(viewProblems(core, viewed, "latest")).toEqual([
      expect.stringMatching(/dist-tag latest is not set/),
    ])
  })
})

describe("a downloaded tarball", () => {
  it("must have the registry's sha512", () => {
    const bytes = Buffer.from("tarball")
    expect(integrityProblems("x", bytes, integrity(bytes))).toEqual([])
    expect(integrityProblems("x", Buffer.from("tarbaIl"), integrity(bytes))).toEqual([
      "x: the tarball's sha512 is not dist.integrity.",
    ])
  })
})

describe("the arguments", () => {
  it("default to the repository's version under next", () => {
    expect(parseArgs([], VERSION)).toEqual({ tag: "next", version: VERSION })
    expect(parseArgs(["--tag", "latest", "--version", "0.1.0"], VERSION)).toEqual({
      tag: "latest",
      version: "0.1.0",
    })
  })

  it.each([
    [["--tag", "next; rm -rf ~"]],
    [["--tag", "next&calc"]],
    [["--tag", '"next"']],
    [["--tag", "%PATH%"]],
    [["--version", "0.1.0 || 9"]],
    [["--version", "x; 0.1.0"]],
    [["--version", "latest"]],
    [["--tag"]],
    [["--registry", "https://example.com"]],
  ])("refuse %j before any command runs", (argv) => {
    expect(() => parseArgs(argv, VERSION)).toThrow()
  })
})
