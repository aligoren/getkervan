// Security review (release, supply chain and CLI): checks that held up, kept as regression tests.
import { execSync } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { CreateError, createProject } from "../../src/create.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")
const template = path.join(root, "packages", "cli", "templates", "basic")
const PACKAGES = ["core", "transport", "spec-runtime", "cli", "create-kervan"]

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function packedFiles(dir: string): string[] {
  // A fixed command line; nothing from outside reaches the shell.
  const out = execSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 60_000,
  })
  const [info] = JSON.parse(out) as { files: { path: string }[] }[]
  return (info?.files ?? []).map((file) => file.path)
}

describe("packed tarballs", () => {
  it.each(PACKAGES)(
    "%s ships no env files, keys, databases or tests",
    { timeout: 90_000 },
    (name) => {
      const files = packedFiles(path.join(root, "packages", name))
      const suspicious = files.filter((file) =>
        /(^|\/)(\.env(\..*)?|.*\.(db|sqlite|pem|key|p12|tgz|tsbuildinfo)|\.kervan-studio\/.*|test\/.*|.*\.test\.[cm]?[jt]sx?)$/i.test(
          file,
        ),
      )
      // The scaffold's own test file is meant to be there.
      expect(suspicious.filter((file) => !file.startsWith("templates/basic/"))).toEqual([])
    },
  )

  it("no publishable package runs an install-time lifecycle script", async () => {
    for (const name of PACKAGES) {
      const manifest = JSON.parse(
        await readFile(path.join(root, "packages", name, "package.json"), "utf8"),
      ) as { scripts?: Record<string, string> }
      const scripts = Object.keys(manifest.scripts ?? {})
      expect(
        scripts.filter((script) => /^(pre|post)?install$|^prepare$/.test(script)),
        name,
      ).toEqual([])
    }
  })
})

describe("the project template", () => {
  it("ignores .env files, refuses wrong Node versions and has no install scripts", async () => {
    const gitignore = await readFile(path.join(template, "_gitignore"), "utf8")
    expect(gitignore).toMatch(/^\.env$/m)
    expect(gitignore).toMatch(/^\.env\.\*$/m)
    expect(await readFile(path.join(template, "_npmrc"), "utf8")).toMatch(/^engine-strict=true$/m)
    const manifest = JSON.parse(await readFile(path.join(template, "package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
    expect(
      Object.keys(manifest.scripts).filter((script) =>
        /^(pre|post)?install$|^prepare$/.test(script),
      ),
    ).toEqual([])
  })

  it.each(['a";process.exit(1);"', "$(touch pwned)", "a&calc", "../escape", "Upper", "a b"])(
    "refuses %j as a package name before writing anything",
    async (name) => {
      const cwd = await mkdtemp(path.join(os.tmpdir(), "kervan-review-create-"))
      dirs.push(cwd)
      await expect(
        createProject({ dir: "project", name, cwd, install: false }),
      ).rejects.toBeInstanceOf(CreateError)
    },
  )
})
