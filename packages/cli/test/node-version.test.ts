import { existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { run } from "../src/index.js"
import {
  describeEngines,
  NODE_ENGINES,
  nodeVersionProblem,
  type RuntimeInfo,
  satisfiesEngines,
  typeStrippingProblem,
} from "../src/node-version.js"

const runtime = (version: string, extra: Partial<RuntimeInfo> = {}): RuntimeInfo => ({
  version,
  platform: "linux",
  typescript: "strip",
  ...extra,
})

describe("the supported Node.js releases", () => {
  it("come from this package's engines", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { engines: { node: string } }
    expect(NODE_ENGINES).toBe(manifest.engines.node)
    expect(describeEngines()).toBe("22.23.3 or a later 22.x, or 24.21.0 or later")
  })

  it.each([
    ["v20.19.0", false],
    ["v22.17.1", false],
    ["v22.18.0", false],
    ["v22.23.2", false],
    ["v22.23.3", true],
    ["v22.24.0", true],
    ["v23.6.0", false],
    ["v24.0.0", false],
    ["v24.15.0", false],
    ["v24.20.9", false],
    ["v24.21.0", true],
    ["v25.0.0", true],
    ["v26.10.0", true],
  ])("%s → %s", (version, expected) => {
    expect(satisfiesEngines(version)).toBe(expected)
  })
})

describe("nodeVersionProblem and typeStrippingProblem", () => {
  it("name the required versions on an untested Node.js", () => {
    for (const version of ["v22.17.1", "v24.15.0"]) {
      expect(nodeVersionProblem(runtime(version))).toMatch(
        new RegExp(
          `22\\.23\\.3 or a later 22\\.x, or 24\\.21\\.0 or later; you are running ${version}`,
        ),
      )
      expect(typeStrippingProblem(runtime(version))).toBe(nodeVersionProblem(runtime(version)))
    }
  })

  it("explains a disabled type stripping", () => {
    expect(typeStrippingProblem(runtime("v24.21.0", { typescript: false }))).toMatch(
      /--no-experimental-strip-types/,
    )
  })

  it("accept supported runtimes", () => {
    expect(nodeVersionProblem(runtime("v22.23.3"))).toBeUndefined()
    expect(typeStrippingProblem(runtime("v24.21.0"))).toBeUndefined()
  })
})

describe("kervan on an untested Node.js", () => {
  // Outside the repository: if the check ever let `create` through, nothing lands in the tree.
  const target = path.join(tmpdir(), `kervan-node-version-${process.pid}`, "anything")
  for (const command of [
    ["create", target, "--no-install"],
    ["dev", "src/index.ts"],
    ["run", "kervan.yaml"],
  ]) {
    it(`${command[0]}: fails with one clear line before doing anything`, async () => {
      const out: string[] = []
      const err: string[] = []
      const code = await run(command, {
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        runtime: runtime("v24.15.0"),
      })
      expect(code).toBe(1)
      expect(err).toHaveLength(1)
      expect(err[0]).toMatch(/^Error: Kervan needs Node\.js 22\.23\.3 .*v24\.15\.0/)
      expect(out).toEqual([])
      expect(existsSync(target)).toBe(false)
    })
  }
})
