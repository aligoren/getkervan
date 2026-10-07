// Studio's port already in use: one line naming the port and KERVAN_STUDIO_PORT, exit code 1.
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:net"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeAll, expect, it } from "vitest"
import { runStudioCli } from "../src/cli.js"

let busy: Server
let port = 0
let dir = ""
beforeAll(async () => {
  busy = createServer()
  await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve))
  port = (busy.address() as { port: number }).port
  dir = mkdtempSync(path.join(os.tmpdir(), "kervan-studio-port-"))
})
afterAll(async () => {
  await new Promise<void>((resolve) => busy.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

it("says the port is taken and how to choose another, instead of a stack trace", async () => {
  const errors: string[] = []
  const code = await runStudioCli(["start"], {
    out: () => {},
    err: (line) => errors.push(line),
    env: {
      KERVAN_STUDIO_PORT: String(port),
      KERVAN_STUDIO_DATA_DIR: path.join(dir, "data"),
      KERVAN_STUDIO_MASTER_KEY: Buffer.alloc(32, 3).toString("base64"),
    },
    cwd: dir,
    readStdin: async () => "",
  })
  expect(code).toBe(1)
  expect(errors.at(-1)).toBe(
    `Error: Port ${port} on 127.0.0.1 is already in use. Stop the program using it, or set KERVAN_STUDIO_PORT to another port.`,
  )
  expect(errors.join("\n")).not.toMatch(/^\s+at /m)
})
