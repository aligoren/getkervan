import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { CreateError, createProject, detectPackageManager } from "../src/create.js"

const cliRoot = fileURLToPath(new URL("..", import.meta.url))
const temps: string[] = []

/** A temp parent directory whose path contains a space, like many Windows user folders. */
async function tempParent(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kervan cli "))
  temps.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const EXPECTED_FILES = [
  ".gitignore",
  "README.md",
  "package.json",
  "src/app.ts",
  "src/index.ts",
  "test/app.test.ts",
  "tsconfig.json",
]

describe("createProject", () => {
  it("writes the template with every placeholder filled", async () => {
    const parent = await tempParent()
    const result = await createProject({ dir: path.join(parent, "my-server"), install: false })
    expect(result.name).toBe("my-server")
    expect(result.files).toEqual(EXPECTED_FILES)
    expect(result.installed).toBe(false)

    for (const file of EXPECTED_FILES) {
      const content = await readFile(path.join(result.dir, file), "utf8")
      expect(content, file).not.toMatch(/\{\{\w+\}\}/)
    }
    const manifest = JSON.parse(await readFile(path.join(result.dir, "package.json"), "utf8"))
    expect(manifest).toMatchObject({
      name: "my-server",
      type: "module",
      engines: { node: "^22.18.0 || >=23.6.0" },
      dependencies: { "@kervan/core": "^0.1.0", "@kervan/transport": "^0.1.0" },
      devDependencies: { kervan: "^0.1.0" },
      scripts: { dev: "kervan dev src/index.ts", start: "node src/index.ts" },
    })
    expect(existsSync(path.join(result.dir, "_gitignore"))).toBe(false)
  })

  it.runIf(process.platform === "win32")(
    "accepts mixed \\ and / separators on Windows",
    async () => {
      const parent = await tempParent()
      const result = await createProject({ dir: `${parent}\\nested/one\\`, install: false })
      expect(result.name).toBe("one")
      expect(result.dir).toBe(path.join(parent, "nested", "one"))
      expect(existsSync(path.join(parent, "nested", "one", "src", "app.ts"))).toBe(true)
      // Reported paths always use "/", whatever the platform separator.
      expect(result.files).toContain("test/app.test.ts")
    },
  )

  it("resolves relative paths against cwd", async () => {
    const parent = await tempParent()
    const relative = await createProject({ dir: "nested/two", cwd: parent, install: false })
    expect(relative.dir).toBe(path.join(parent, "nested", "two"))
    expect(relative.files).toContain("src/index.ts")
  })

  it("uses --name for directories that are not valid package names", async () => {
    const parent = await tempParent()
    const dir = path.join(parent, "My Server")
    await expect(createProject({ dir, install: false })).rejects.toThrow(CreateError)
    const result = await createProject({ dir, name: "@acme/my-server", install: false })
    const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"))
    expect(result.name).toBe("@acme/my-server")
    expect(manifest.name).toBe("@acme/my-server")
  })

  it("refuses a non-empty directory but accepts an empty one", async () => {
    const parent = await tempParent()
    const full = path.join(parent, "full")
    await mkdir(full)
    await writeFile(path.join(full, "keep.txt"), "mine")
    await expect(createProject({ dir: full, install: false })).rejects.toThrow(/not empty/)
    expect(await readFile(path.join(full, "keep.txt"), "utf8")).toBe("mine")

    const empty = path.join(parent, "empty")
    await mkdir(empty)
    await expect(createProject({ dir: empty, install: false })).resolves.toMatchObject({
      name: "empty",
    })
  })

  it("detects the package manager that ran it", () => {
    expect(detectPackageManager("pnpm/12.9.1 npm/? node/v24.21.0 win32 x64")).toBe("pnpm")
    expect(detectPackageManager("yarn/4.9.0 npm/? node/v22.18.0")).toBe("yarn")
    expect(detectPackageManager("npm/11.12.1 node/v24.15.0 win32 x64 workspaces/false")).toBe("npm")
    expect(detectPackageManager("")).toBe("npm")
  })
})

function runBin(script: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  // Windows treats variable names case-insensitively: drop every spelling of an overridden name.
  const overridden = new Set(Object.keys(env).map((key) => key.toLowerCase()))
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !overridden.has(key.toLowerCase())),
  )
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...base, ...env },
  })
}

describe("command line", () => {
  it("kervan create works with a path containing spaces", async () => {
    const parent = await tempParent()
    const target = path.join(parent, "cli-made")
    const result = runBin(
      path.join(cliRoot, "bin", "kervan.js"),
      ["create", target, "--no-install"],
      parent,
    )
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain("Created cli-made")
    expect(existsSync(path.join(target, "src", "app.ts"))).toBe(true)
  })

  it.each([
    ["npm/11.12.1 node/v24.21.0", "npm install", "npm run dev"],
    ["pnpm/12.9.1 npm/? node/v24.21.0", "pnpm install", "pnpm dev"],
    ["yarn/4.9.0 npm/? node/v24.21.0", "yarn install", "yarn dev"],
    ["bun/1.3.0 npm/? node/v24.21.0", "bun install", "bun run dev"],
  ])("prints next steps for the package manager that ran it (%s)", async (agent, install, dev) => {
    const parent = await tempParent()
    const result = runBin(
      path.join(cliRoot, "bin", "kervan.js"),
      ["create", "steps", "--no-install"],
      parent,
      { npm_config_user_agent: agent },
    )
    expect(result.status, result.stderr).toBe(0)
    const steps = result.stdout.split("Next steps:")[1] ?? ""
    expect(steps.split(/\r?\n/).map((line) => line.trim())).toEqual(
      expect.arrayContaining(["cd steps", install, dev]),
    )
  })

  it("create-kervan forwards to kervan create", async () => {
    const parent = await tempParent()
    const bin = path.join(cliRoot, "..", "create-kervan", "bin", "create-kervan.js")
    const result = runBin(bin, ["via-create", "--no-install"], parent)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(path.join(parent, "via-create", "package.json"))).toBe(true)
  })

  it("reports usage errors with exit code 1", async () => {
    const parent = await tempParent()
    const bin = path.join(cliRoot, "bin", "kervan.js")
    expect(runBin(bin, ["create"], parent).status).toBe(1)
    expect(runBin(bin, ["create", "x", "--pm", "pip", "--no-install"], parent).stderr).toMatch(
      /--pm must be/,
    )
    expect(runBin(bin, ["launch"], parent).stderr).toMatch(/Unknown command "launch"/)
    expect(runBin(bin, ["--version"], parent).stdout.trim()).toBe("0.1.0")
    // Four process starts: slow on a busy Windows machine.
  }, 30_000)
})
