// The npm package checks of `pnpm test:pack` (scripts/pack-check.mjs): what a tarball may hold and
// what its package.json may say. `pnpm test:pack` runs them on every package and then installs the
// tarballs; this suite checks the rules themselves, and reads one real tarball.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { gzipSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import {
  contentProblems,
  manifestProblems,
  orphanProblems,
  PACKAGES,
  readTarball,
  sourceMapProblems,
} from "../pack-check.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const pkg = (name: string) => {
  const found = PACKAGES.find((each) => each.name === name)
  if (!found) throw new Error(`no published package ${name}`)
  return found
}
const BASE = ["LICENSE", "README.md", "package.json"]

describe("a package's files", () => {
  it("accept what each package ships", () => {
    expect(
      contentProblems(pkg("@kervan/core"), [...BASE, "dist/index.js", "dist/index.d.ts"], 1000),
    ).toEqual([])
    expect(
      contentProblems(
        pkg("kervan"),
        [
          ...BASE,
          "bin/kervan.js",
          "dist/index.js",
          "templates/basic/src/app.ts",
          "templates/basic/test/app.test.ts",
        ],
        1000,
      ),
    ).toEqual([])
    expect(
      contentProblems(pkg("@kervan/spec-runtime"), [...BASE, "schema/kervan.schema.json"], 1000),
    ).toEqual([])
  })

  it.each([
    [".env.studio", "an environment file"],
    ["dist/.env", "an environment file"],
    ["data/studio.sqlite-wal", "a database file"],
    ["certs/server.key", "a key or certificate"],
    ["test/app.test.js", "a test"],
    ["src/index.ts", "a source file"],
    ["dist/index.js.map", "a source map"],
    ["CLAUDE.md", "a local tool file"],
    ["screenshots/editor.webp", "a scratch or screenshot folder"],
    ["dist/logo.png", "an image"],
  ])("refuse %s (%s)", (file, kind) => {
    expect(contentProblems(pkg("@kervan/core"), [...BASE, file], 1000)).toEqual([
      expect.stringContaining(`is ${kind}`),
    ])
  })

  it("refuse a file off the allow list, a missing license and a package over budget", () => {
    expect(contentProblems(pkg("@kervan/core"), [...BASE, "notes.txt"], 1000)).toEqual([
      expect.stringContaining("not on the package's allow list"),
    ])
    expect(contentProblems(pkg("@kervan/core"), ["README.md", "package.json"], 1000)).toEqual([
      expect.stringContaining("LICENSE is missing"),
    ])
    expect(contentProblems(pkg("@kervan/core"), BASE, 10_000_000)).toEqual([
      expect.stringContaining("over the"),
    ])
  })

  it("let the project template keep its sources, but never a secret", () => {
    expect(contentProblems(pkg("kervan"), [...BASE, "templates/basic/.env"], 1000)).toEqual([
      expect.stringContaining("an environment file"),
    ])
  })
})

describe("build output", () => {
  it("each compiled file has its source; one left over from a deleted module is flagged", () => {
    const sources = new Set(["src/index.ts", "src/dev/host.ts"])
    const files = [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/dev/host.js",
      "dist/old.js",
      "dist/old.d.ts",
    ]
    expect(orphanProblems(pkg("kervan"), files, (file) => sources.has(file))).toEqual([
      "kervan: dist/old.js has no source (src/old.ts); rebuild from a clean checkout.",
      "kervan: dist/old.d.ts has no source (src/old.ts); rebuild from a clean checkout.",
    ])
    // Files outside dist (bin scripts, the template, the schema) are not build output.
    expect(
      orphanProblems(pkg("kervan"), ["bin/kervan.js", "templates/basic/src/app.ts"], () => false),
    ).toEqual([])
  })
})

describe("a packed package.json", () => {
  it("has no workspace:, link: or file: version, and the package's own name and version", () => {
    const core = pkg("@kervan/core")
    expect(
      manifestProblems(
        core,
        { name: "@kervan/core", version: "1.0.0", dependencies: { zod: "^4" } },
        "1.0.0",
      ),
    ).toEqual([])
    expect(
      manifestProblems(
        core,
        { name: "@kervan/core", version: "1.0.0", dependencies: { "@kervan/x": "workspace:^" } },
        "1.0.0",
      ),
    ).toEqual([expect.stringContaining('dependencies.@kervan/x is "workspace:^"')])
    expect(
      manifestProblems(
        core,
        { name: "@kervan/core", version: "1.0.0", peerDependencies: { a: "file:../a" } },
        "1.0.0",
      ),
    ).toHaveLength(1)
    expect(manifestProblems(core, { name: "other", version: "2.0.0" }, "1.0.0")).toHaveLength(2)
  })
})

/** A gzipped tar with the given entries: [name, body, type, prefix]. */
function tarball(dir: string, entries: [string, string, string?, string?][]) {
  const blocks = entries.flatMap(([name, body, type = "0", prefix = ""]) => {
    const header = Buffer.alloc(512)
    header.write(name, 0)
    header.write(`${Buffer.byteLength(body).toString(8).padStart(11, "0")}\0`, 124)
    header.write(type, 156)
    header.write("ustar\0", 257)
    header.write(prefix, 345)
    const data = Buffer.alloc(Math.ceil(Buffer.byteLength(body) / 512) * 512)
    data.write(body)
    return [header, data]
  })
  const file = path.join(dir, "test.tgz")
  writeFileSync(file, gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)])))
  return file
}

describe("reading a tarball", () => {
  it("joins a long path's prefix to its name, and counts the bytes", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kervan-pack-test-"))
    try {
      const packed = readTarball(
        tarball(dir, [
          ["package/package.json", '{"name":"x","version":"1.0.0"}'],
          ["deep/file.js", "abc", "0", "package/dist"],
        ]),
      )
      expect(packed.files).toEqual(["dist/deep/file.js", "package.json"])
      expect(packed.size).toBe(33)
      expect(packed.manifest).toEqual({ name: "x", version: "1.0.0" })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("finds the source maps that scripts name, and flags one that is not in the package", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kervan-pack-test-"))
    try {
      const packed = readTarball(
        tarball(dir, [
          ["package/package.json", '{"name":"x","version":"1.0.0"}'],
          ["package/dist/a.js", "export {}\n//# sourceMappingURL=a.js.map\n"],
          ["package/dist/a.js.map", "{}"],
          ["package/dist/b.js", "export {}\n//# sourceMappingURL=b.js.map\n"],
          ["package/dist/c.js", "//# sourceMappingURL=data:application/json;base64,e30=\n"],
        ]),
      )
      expect(packed.mapRefs).toEqual([
        { file: "dist/a.js", map: "dist/a.js.map" },
        { file: "dist/b.js", map: "dist/b.js.map" },
      ])
      expect(sourceMapProblems(pkg("@kervan/core"), packed.files, packed.mapRefs)).toEqual([
        "@kervan/core: dist/b.js refers to dist/b.js.map, which is not in the package.",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("refuses a link or a pax header, which could make the list differ from what npm unpacks", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kervan-pack-test-"))
    try {
      for (const type of ["2", "x", "L"]) {
        expect(() => readTarball(tarball(dir, [["package/a", "", type]]))).toThrow(
          `unexpected tar entry type "${type}"`,
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("a real tarball", () => {
  it("is read without unpacking: create-kervan's files, and its kervan dependency as a version", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kervan-pack-test-"))
    try {
      const shell = process.platform === "win32"
      const result = spawnSync(
        shell ? `pnpm pack --pack-destination "${dir}"` : "pnpm",
        shell ? [] : ["pack", "--pack-destination", dir],
        {
          cwd: path.join(root, "packages", "create-kervan"),
          encoding: "utf8",
          shell,
        },
      )
      expect(result.status, result.stderr).toBe(0)
      const tarball = readdirSync(dir).find((name) => name.endsWith(".tgz")) ?? ""
      const packed = readTarball(path.join(dir, tarball))
      expect(packed.files).toEqual(["LICENSE", "README.md", "bin/create-kervan.js", "package.json"])
      expect(packed.manifest.dependencies?.kervan).toMatch(/^\^\d+\.\d+\.\d+/)
      expect(
        manifestProblems(pkg("create-kervan"), packed.manifest, String(packed.manifest.version)),
      ).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
