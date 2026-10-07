// A taken port: one line that says which port and how to choose another, a non-zero exit, and no
// stack trace; for `kervan run` and `kervan dev` (spec and code, which also stops its child).
import { spawnSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type Server } from "node:net"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { portInUseMessage } from "../src/listen.js"
import { kervanBin, makeProject } from "./dev-helpers.js"

let busy: Server
let port = 0
let dir = ""
beforeAll(async () => {
  busy = createServer()
  await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve))
  port = (busy.address() as { port: number }).port
  dir = await mkdtemp(path.join(os.tmpdir(), "kervan-port-"))
  await writeFile(
    path.join(dir, "kervan.yaml"),
    `specVersion: 1
name: port-test
version: 0.0.1
tools:
  - name: hello
    description: Says hello
    http: { url: "https://api.example.com/hello" }
    output: { select: "@" }
`,
  )
})
afterAll(async () => {
  await new Promise<void>((resolve) => busy.close(() => resolve()))
  await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

function kervan(args: string[], cwd = dir) {
  return spawnSync(process.execPath, [kervanBin, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
    env: { ...process.env, NODE_ENV: "development" },
  })
}

function expectOneLine(result: ReturnType<typeof kervan>) {
  expect(result.status, result.stderr).toBe(1)
  const expected = `Error: Port ${port} on 127.0.0.1 is already in use. Stop the program using it, or choose another port with --port.`
  expect(result.stderr).toContain(expected)
  expect(result.stderr).not.toMatch(/^\s+at /m)
  expect(result.stderr).not.toContain("EADDRINUSE")
}

describe("a port that is already in use", () => {
  it("stops `kervan run --http` with one line", () => {
    expectOneLine(kervan(["run", "kervan.yaml", "--http", "--port", String(port)]))
  })

  it("stops `kervan dev` of a spec with one line", () => {
    expectOneLine(kervan(["dev", "kervan.yaml", "--http", "--no-repl", "--port", String(port)]))
  })

  it("stops `kervan dev` of code with one line, and its child with it", async () => {
    const project = await makeProject()
    try {
      // spawnSync returns only once every process holding the output pipes has exited.
      expectOneLine(
        kervan(
          ["dev", "src/server.ts", "--http", "--no-repl", "--port", String(port)],
          project.dir,
        ),
      )
    } finally {
      await project.cleanup()
    }
  })

  it("leaves every other error alone", () => {
    expect(portInUseMessage(new Error("boom"), "x")).toBeUndefined()
    expect(portInUseMessage({ code: "EACCES", port: 80 }, "x")).toBeUndefined()
    expect(portInUseMessage({ code: "EADDRINUSE", port: 80, address: "::1" }, "do y")).toBe(
      "Port 80 on ::1 is already in use. Stop the program using it, or do y.",
    )
  })
})
