import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { sha256 } from "../src/crypto.js"
import { MIGRATIONS_FOLDER, openDatabase } from "../src/db/open.js"
import { findSession } from "../src/db/repos/sessions.js"
import { getUser } from "../src/db/repos/users.js"
import { serverSummaries } from "../src/db/repos/version-checks.js"
import { defaultWorkspace } from "../src/db/repos/workspaces.js"
import { STARTER_SPEC } from "../web/src/starter.js"
import { type ApiStudio, apiStudio } from "./api-helpers.js"
import { echoTool, spec } from "./helpers.js"

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A copy of the migrations as Studio shipped them before user management (0000-0004). */
function migrationsUpTo(last: number): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kervan-migrations-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true })
  const journalFile = path.join(dir, "meta", "_journal.json")
  const journal = JSON.parse(readFileSync(journalFile, "utf8")) as { entries: { idx: number }[] }
  journal.entries = journal.entries.filter((entry) => entry.idx <= last)
  writeFileSync(journalFile, JSON.stringify(journal))
  return dir
}

describe("upgrading a database from before user management", () => {
  it("adds the new columns and table, keeping users, sessions and versions", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kervan-upgrade-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const file = path.join(dir, "studio.db")

    // A Studio database at migration 0004, filled the way that Studio wrote it.
    const old = openDatabase(file, { migrationsFolder: migrationsUpTo(4) })
    const scope = defaultWorkspace(old.db)
    const sessionId = "an-old-session-id-0123456789"
    const now = Date.now()
    old.sqlite
      .prepare(
        "INSERT INTO users (id, workspace_id, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("u1", scope.workspaceId, "old@example.test", "scrypt$x", "admin", now, now)
    old.sqlite
      .prepare(
        "INSERT INTO sessions (id_hash, workspace_id, user_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(sha256(sessionId), scope.workspaceId, "u1", now, now, now + 60_000)
    old.sqlite
      .prepare(
        "INSERT INTO servers (id, workspace_id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("s1", scope.workspaceId, "old", "Old", now, now)
    old.sqlite
      .prepare(
        "INSERT INTO spec_versions (id, workspace_id, server_id, number, yaml_text, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("v1", scope.workspaceId, "s1", 1, "specVersion: 1", sha256("specVersion: 1"), now)
    old.close()

    // Today's Studio opens it.
    const upgraded = openDatabase(file)
    cleanups.push(() => upgraded.close())
    const applied = upgraded.sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()
    expect(applied).toEqual({ n: 7 })
    expect(getUser(upgraded.db, scope, "u1")).toMatchObject({
      email: "old@example.test",
      role: "admin",
      displayName: null,
      mustChangePassword: false,
      lastLoginAt: null,
      theme: "system",
    })
    // An old session keeps working, with no recorded IP or browser.
    expect(findSession(upgraded.db, sessionId)?.user).toMatchObject({
      id: "u1",
      mustChangePassword: false,
    })
    // An old version has no check yet: "not checked", not "valid".
    expect(serverSummaries(upgraded.db, scope).get("s1")).toMatchObject({
      latest: { id: "v1", number: 1, check: null },
      publishedNumber: null,
    })
  })
})

describe("version checks", () => {
  const studios: ApiStudio[] = []
  afterEach(async () => {
    for (const s of studios.splice(0)) await s.close()
  })

  async function setup() {
    const s = apiStudio()
    studios.push(s)
    await s.addUser("admin@example.test", "admin")
    await s.addUser("member@example.test", "member")
    const admin = await s.signIn("admin@example.test")
    const member = await s.signIn("member@example.test")
    const created = await s.request("POST", "/api/servers", {
      ...admin,
      body: { slug: "w", name: "W" },
    })
    const id = String((created.json.server as { id: string }).id)
    const save = async (yaml: string) =>
      (await s.request("POST", `/api/servers/${id}/versions`, { ...admin, body: { yaml } })).json
    return { s, admin, member, id, save }
  }

  it("marks each version valid or with its number of problems, in the history and the list", async () => {
    const { s, admin, id, save } = await setup()
    await save(spec(echoTool("https://api.example.com/x")))
    const bad = await save("specVersion: 1\nname: x\nversion: 1\ntools: [{ name: 1 }]\n")
    expect(bad.valid).toBe(false)
    const detail = await s.request("GET", `/api/servers/${id}`, admin)
    const checks = (detail.json.versions as { number: number; check: unknown }[]).map((v) => [
      v.number,
      v.check,
    ])
    expect(checks).toEqual([
      [2, expect.objectContaining({ valid: false, problems: expect.any(Number) })],
      [1, expect.objectContaining({ valid: true, problems: 0 })],
    ])
    expect((checks[0]?.[1] as { problems: number } | undefined)?.problems).toBeGreaterThan(0)
    const list = await s.request("GET", "/api/servers", admin)
    expect((list.json.servers as { summary: unknown }[])[0]?.summary).toMatchObject({
      latest: { number: 2, check: { valid: false } },
      publishedNumber: null,
      lastCallAt: null,
    })
  })

  it("updates a check when publishing finds problems the save did not", async () => {
    const { s, admin, id, save } = await setup()
    // Valid when saved; then the version is published after its secret is gone.
    await s.request("PUT", `/api/servers/${id}/secrets/API_KEY`, {
      ...admin,
      body: { value: "a-secret-value-123", allowedHosts: ["api.example.com"] },
    })
    const saved = await save(
      spec(
        echoTool(
          "https://api.example.com/x",
          "keyed",
          '      headers: { X-Key: "{{secrets.API_KEY}}" }',
        ),
        "secrets: [API_KEY]",
      ),
    )
    expect(saved.valid).toBe(true)
    await s.request("DELETE", `/api/servers/${id}/secrets/API_KEY`, {
      ...admin,
      body: { confirm: true },
    })
    const versionId = String((saved.version as { id: string }).id)
    const refused = await s.request("POST", `/api/servers/${id}/versions/${versionId}/publish`, {
      ...admin,
      body: {},
    })
    expect(refused.status).toBe(400)
    const detail = await s.request("GET", `/api/servers/${id}`, admin)
    expect((detail.json.versions as { check: { valid: boolean } }[])[0]?.check.valid).toBe(false)
  })

  it("gives admins the counts the next-steps list needs, and members only the status", async () => {
    const { s, admin, member, id, save } = await setup()
    await save(spec(echoTool("https://api.example.com/x")))
    await s.request("POST", `/api/servers/${id}/keys`, { ...admin, body: { name: "k" } })
    const forAdmin = await s.request("GET", `/api/servers/${id}/overview`, admin)
    expect(forAdmin.json).toMatchObject({
      summary: { latest: { number: 1, check: { valid: true } } },
      secrets: 0,
      activeKeys: 1,
      keyUsed: false,
    })
    const forMember = await s.request("GET", `/api/servers/${id}/overview`, member)
    expect(forMember.status).toBe(200)
    expect(forMember.json).not.toHaveProperty("secrets")
    expect(forMember.json).not.toHaveProperty("activeKeys")
  })

  it("tells the next steps how many secrets the published version uses", async () => {
    const { s, admin, id, save } = await setup()
    const overview = async () => (await s.request("GET", `/api/servers/${id}/overview`, admin)).json
    expect((await overview()).publishedSecrets).toBeNull()
    const saved = await save(spec(echoTool("https://api.example.com/x")))
    const versionId = String((saved.version as { id: string }).id)
    await s.request("POST", `/api/servers/${id}/versions/${versionId}/publish`, {
      ...admin,
      body: {},
    })
    // A broken newer draft does not hide that the published version needs no secrets.
    await save("specVersion: 1\nname: x\nversion: 1\ntools: [{ name: 1 }]\n")
    expect((await overview()).publishedSecrets).toBe(0)
  })

  it("gives the server page the same status as the list", async () => {
    const { s, admin, id, save } = await setup()
    const saved = await save(spec(echoTool("https://api.example.com/x")))
    const versionId = String((saved.version as { id: string }).id)
    await s.request("POST", `/api/servers/${id}/versions/${versionId}/publish`, {
      ...admin,
      body: {},
    })
    await save("specVersion: 1\nname: x\nversion: 1\ntools: [{ name: 1 }]\n")
    const detail = await s.request("GET", `/api/servers/${id}`, admin)
    expect((detail.json.server as { summary: unknown }).summary).toMatchObject({
      latest: { number: 2, check: { valid: false } },
      publishedNumber: 1,
      lastCallAt: null,
    })
  })

  it("reports a valid version even when the newest one has problems (next steps)", async () => {
    const { s, admin, id, save } = await setup()
    const overview = async () => (await s.request("GET", `/api/servers/${id}/overview`, admin)).json
    const broken = "specVersion: 1\nname: x\nversion: 1\ntools: [{ name: 1 }]\n"
    expect((await overview()).anyValid).toBe(false)
    await save(broken)
    expect((await overview()).anyValid).toBe(false)
    await save(spec(echoTool("https://api.example.com/x")))
    await save(broken)
    const after = await overview()
    expect(after.anyValid).toBe(true)
    expect(after.summary).toMatchObject({ latest: { number: 3, check: { valid: false } } })
  })

  it("accepts the starter spec a new server begins with (timezone: auto included)", async () => {
    const { save } = await setup()
    expect(STARTER_SPEC).toContain("timezone: auto")
    const saved = await save(STARTER_SPEC)
    expect(saved.issues).toEqual([])
    expect(saved.valid).toBe(true)
  })
})
