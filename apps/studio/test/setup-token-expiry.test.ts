// The setup token expires after 30 minutes (a fake clock moves time), and the answer says what to
// do: restart Studio for a new token. Also the start-up message when the master key is missing.
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { runStudioCli } from "../src/cli.js"
import { openDatabase } from "../src/db/open.js"
import { SETUP_TOKEN_TTL_MS } from "../src/db/repos/tokens.js"
import { defaultWorkspace } from "../src/db/repos/workspaces.js"
import { staticKeyProvider } from "../src/keys.js"
import { DATABASE_FILE } from "../src/server.js"
import { DbSecretStore } from "../src/vault.js"
import { type ApiStudio, apiStudio, PASSWORD } from "./api-helpers.js"

const studios: ApiStudio[] = []
const dirs: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const s of studios.splice(0)) await s.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
})

const ADVICE =
  "The setup token is invalid or has expired. Restart Studio: its console prints a new setup token, valid for 30 minutes."

describe("the setup token", () => {
  it("works until 30 minutes have passed, then says to restart Studio", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"))
    const s = apiStudio()
    studios.push(s)
    const token = s.setupToken()
    const setup = () =>
      s.request("POST", "/api/setup", {
        body: { token, email: "admin@example.test", password: PASSWORD },
      })
    vi.setSystemTime(Date.now() + SETUP_TOKEN_TTL_MS + 1)
    const expired = await setup()
    expect(expired.status).toBe(403)
    expect(expired.json.error).toBe(ADVICE)
    // A wrong token gets the same advice.
    const wrong = await s.request("POST", "/api/setup", {
      body: { token: "not-the-token", email: "admin@example.test", password: PASSWORD },
    })
    expect(wrong.json.error).toBe(ADVICE)
  })

  it("is accepted just before it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-10-07T12:00:00Z"))
    const s = apiStudio()
    studios.push(s)
    const token = s.setupToken()
    vi.setSystemTime(Date.now() + SETUP_TOKEN_TTL_MS - 1000)
    const ok = await s.request("POST", "/api/setup", {
      body: { token, email: "admin@example.test", password: PASSWORD },
    })
    expect(ok.status).toBe(201)
  })
})

describe("starting without a master key", () => {
  async function start(dataDir: string) {
    const errors: string[] = []
    const code = await runStudioCli(["start"], {
      out: () => {},
      err: (line) => errors.push(line),
      env: { KERVAN_STUDIO_DATA_DIR: dataDir, KERVAN_STUDIO_PORT: "0" },
      cwd: dataDir,
      readStdin: async () => "",
    })
    return { code, error: errors.join("\n") }
  }
  const tempDir = () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kervan-nokey-"))
    dirs.push(dir)
    return dir
  }

  it("tells a new installation how to create a key", async () => {
    const { code, error } = await start(tempDir())
    expect(code).toBe(1)
    expect(error).toContain("KERVAN_STUDIO_MASTER_KEY is not set")
    expect(error).toContain("Create one with")
  })

  it("tells an installation with secrets to give its own key, not a new one", async () => {
    const dir = tempDir()
    const database = openDatabase(path.join(dir, DATABASE_FILE))
    const store = new DbSecretStore(
      database.db,
      staticKeyProvider({ version: 1, key: Buffer.alloc(32, 5) }),
    )
    const scope = defaultWorkspace(database.db)
    const { createServer } = await import("../src/db/repos/servers.js")
    const server = createServer(database.db, scope, { slug: "w", name: "W" })
    await store.put(scope, server.id, {
      name: "API_KEY",
      value: "a-stored-secret-1234",
      allowedHosts: ["api.example.com"],
    })
    database.close()
    const { code, error } = await start(dir)
    expect(code).toBe(1)
    expect(error).toContain("already holds 1 encrypted secret")
    expect(error).toContain("Do not create a new one")
    expect(error).not.toContain("Create one with")
  })
})
