import { spawnSync } from "node:child_process"
import { realpathSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createProject } from "../src/create.js"

const repo = fileURLToPath(new URL("../../..", import.meta.url))
let project = ""
let parent = ""

/**
 * Stands in for `npm install` (the packages are not published yet): links the generated project's
 * dependencies to this workspace with directory junctions, which work on Windows without admin.
 */
async function linkDependencies(dir: string) {
  const links: Record<string, string> = {
    "@kervan/core": path.join(repo, "packages/core"),
    "@kervan/transport": path.join(repo, "packages/transport"),
    "@modelcontextprotocol/client": realpathSync(
      path.join(repo, "packages/transport/node_modules/@modelcontextprotocol/client"),
    ),
    "@types/node": realpathSync(path.join(repo, "node_modules/@types/node")),
    vitest: realpathSync(path.join(repo, "node_modules/vitest")),
  }
  for (const [name, target] of Object.entries(links)) {
    const link = path.join(dir, "node_modules", name)
    await mkdir(path.dirname(link), { recursive: true })
    await symlink(target, link, "junction")
  }
}

beforeAll(async () => {
  parent = await mkdtemp(path.join(os.tmpdir(), "kervan e2e "))
  const result = await createProject({ dir: path.join(parent, "e2e-server"), install: false })
  project = result.dir
  await linkDependencies(project)
})

afterAll(async () => {
  if (parent) await rm(parent, { recursive: true, force: true })
})

describe("a generated project", () => {
  it("type-checks", () => {
    const tsc = spawnSync(
      process.execPath,
      [path.join(repo, "node_modules/typescript/bin/tsc"), "-p", project, "--noEmit"],
      { encoding: "utf8" },
    )
    expect(tsc.status, tsc.stdout + tsc.stderr).toBe(0)
  })

  it.each(["legacy", "modern"] as const)(
    "runs its TypeScript sources directly over stdio (%s era)",
    async (era) => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(project, "src", "index.ts")],
        cwd: project,
        stderr: "pipe",
      })
      const client = new Client(
        { name: "e2e", version: "0.0.0" },
        era === "modern" ? { versionNegotiation: { mode: { pin: "2026-07-28" } } } : {},
      )
      await client.connect(transport)
      try {
        const { tools } = await client.listTools()
        expect(tools.map((tool) => tool.name)).toEqual(["greet", "divide"])
        const greet = await client.callTool({ name: "greet", arguments: { name: "Ada" } })
        expect(greet.content).toEqual([{ type: "text", text: "Hello, Ada!" }])
        const divide = await client.callTool({ name: "divide", arguments: { a: 1, b: 4 } })
        expect(divide.structuredContent).toEqual({ result: 0.25 })
      } finally {
        await client.close()
      }
    },
  )

  it("passes its own tests", () => {
    const vitest = spawnSync(
      process.execPath,
      [path.join(repo, "node_modules/vitest/vitest.mjs"), "run", "--root", project],
      { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
    )
    expect(vitest.status, vitest.stdout + vitest.stderr).toBe(0)
    expect(vitest.stdout).toMatch(/Tests\s+2 passed/)
  })
})
