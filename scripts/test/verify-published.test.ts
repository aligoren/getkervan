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
  REGISTRY,
  same,
  tarballName,
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

describe("the repository field, as the registry orders its keys", () => {
  // npm view answers { url, type, directory }; package.json has { type, url, directory }.
  const fromRegistry = (repository: Record<string, string>) => ({ ...goodView(), repository })
  const url = core.repository.url
  const directory = core.repository.directory

  it("passes with the same content in the registry's order", () => {
    const viewed = fromRegistry({ url, type: "git", directory })
    expect(Object.keys(viewed.repository)).toEqual(["url", "type", "directory"])
    expect(viewProblems(core, viewed, "next")).toEqual([])
  })

  it.each([
    ["another url", { url: "git+https://github.com/someone/else.git", type: "git", directory }],
    ["another directory", { url, type: "git", directory: "packages/cli" }],
    ["another type", { url, type: "svn", directory }],
    ["a missing field", { url, type: "git" }],
    ["an extra field", { url, type: "git", directory, web: "https://example.com" }],
  ])("fails with %s", (_, repository) => {
    expect(viewProblems(core, fromRegistry(repository), "next")).toEqual([
      expect.stringMatching(/^@kervan\/core: repository /),
    ])
  })
})

describe("comparing data (same)", () => {
  it("ignores key order at every depth, nothing else", () => {
    expect(
      same({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }, { b: { c: [1, { e: 3, d: 2 }] }, a: 1 }),
    ).toBe(true)
    expect(same({ a: 1 }, { a: "1" })).toBe(false)
    expect(same({ a: [1, 2] }, { a: [2, 1] })).toBe(false)
    expect(same({ a: undefined }, {})).toBe(false)
    expect(same(undefined, {})).toBe(false)
    expect(same(null, {})).toBe(false)
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

describe("the published tarballs (--tarballs)", () => {
  it("are found by the names pnpm pack gives them", () => {
    expect(expected.map((each) => tarballName(each.name, VERSION))).toEqual([
      "kervan-core-0.1.0-rc.1.tgz",
      "kervan-transport-0.1.0-rc.1.tgz",
      "kervan-spec-runtime-0.1.0-rc.1.tgz",
      "kervan-0.1.0-rc.1.tgz",
      "create-kervan-0.1.0-rc.1.tgz",
    ])
  })

  it("are compared on every npm command with the public registry, not a configured one", () => {
    expect(REGISTRY).toBe("https://registry.npmjs.org/")
    const source = readFileSync(path.join(root, "scripts/verify-published.mjs"), "utf8")
    const npmCalls = [...source.matchAll(/run\(\s*"npm",\s*\[([^\]]*)\]/g)].map((m) => m[1] ?? "")
    expect(npmCalls.length).toBeGreaterThanOrEqual(4)
    for (const args of npmCalls.filter((each) => !/"test"/.test(each)))
      expect(args, args).toMatch(/"--registry",\s*REGISTRY/)
  })
})

describe("the arguments", () => {
  it("default to the repository's version under next", () => {
    expect(parseArgs([], VERSION)).toEqual({ tag: "next", version: VERSION, tarballs: undefined })
    expect(
      parseArgs(["--tag", "latest", "--version", "0.1.0", "--tarballs", "out"], VERSION),
    ).toEqual({ tag: "latest", version: "0.1.0", tarballs: path.resolve("out") })
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
