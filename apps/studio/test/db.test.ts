import {
  chmodSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { sha256 } from "../src/crypto.js"
import { DatabaseError, MIGRATIONS_FOLDER, openDatabase } from "../src/db/open.js"
import { recordAudit } from "../src/db/repos/audit.js"
import { createServer } from "../src/db/repos/servers.js"
import {
  createSession,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  sessionAlive,
} from "../src/db/repos/sessions.js"
import {
  consumeSetupToken,
  issueSetupToken,
  SETUP_TOKEN_TTL_MS,
  setupTokenValid,
} from "../src/db/repos/tokens.js"
import { createUser, setDisabledAt } from "../src/db/repos/users.js"
import { saveVersion } from "../src/db/repos/versions.js"
import { createWorkspace, defaultWorkspace } from "../src/db/repos/workspaces.js"
import { sessions } from "../src/db/schema.js"

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kervan-studio-db-"))
  temps.push(dir)
  return dir
}

describe("opening the database", () => {
  it("uses WAL, a busy timeout and foreign keys", () => {
    const file = path.join(tempDir(), "data", "studio.db")
    const { sqlite, close } = openDatabase(file)
    try {
      expect(sqlite.pragma("journal_mode", { simple: true })).toBe("wal")
      expect(sqlite.pragma("busy_timeout", { simple: true })).toBe(5000)
      expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1)
    } finally {
      close()
    }
  })

  it.runIf(process.platform !== "win32")("makes the directory and files owner-only", () => {
    const dir = path.join(tempDir(), "data")
    const file = path.join(dir, "studio.db")
    const { db, close } = openDatabase(file)
    createWorkspace(db, "w")
    try {
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      for (const suffix of ["", "-wal", "-shm"]) {
        expect(statSync(file + suffix).mode & 0o777, suffix || "db").toBe(0o600)
      }
    } finally {
      close()
    }
  })

  it.runIf(process.platform !== "win32")("tightens an existing world-readable database", () => {
    const file = path.join(tempDir(), "studio.db")
    openDatabase(file).close()
    chmodSync(file, 0o644)
    openDatabase(file).close()
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it("refuses to open when a migration fails", () => {
    const file = path.join(tempDir(), "studio.db")
    // A table the first migration wants to create already exists with another shape.
    const raw = new Database(file)
    raw.exec("CREATE TABLE workspaces (unexpected TEXT)")
    raw.close()
    expect(() => openDatabase(file)).toThrow(DatabaseError)
    expect(() => openDatabase(file)).toThrow(/migration failed; Studio will not start/)
  })

  it("refuses to open a database written by a newer Studio", () => {
    const file = path.join(tempDir(), "studio.db")
    openDatabase(file).close()
    // Simulate a newer release: copy the migrations and add one this build does not know.
    const folder = path.join(tempDir(), "migrations")
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true })
    const journalFile = path.join(folder, "meta", "_journal.json")
    const journal = JSON.parse(readFileSync(journalFile, "utf8"))
    const last = journal.entries.at(-1)
    journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag: "9999_future" })
    writeFileSync(journalFile, JSON.stringify(journal))
    writeFileSync(path.join(folder, "9999_future.sql"), "CREATE TABLE future_table (x TEXT);")
    openDatabase(file, { migrationsFolder: folder }).close()
    expect(() => openDatabase(file)).toThrow(/created by a newer version/)
  })
})

describe("integrity rules in the schema", () => {
  it("never updates a saved spec version", () => {
    const { db, sqlite, close } = openDatabase(":memory:")
    try {
      const scope = createWorkspace(db, "w")
      const server = createServer(db, scope, { slug: "s", name: "S" })
      const version = saveVersion(db, scope, server.id, "specVersion: 1", null)
      expect(() =>
        sqlite.prepare("UPDATE spec_versions SET yaml_text = 'x' WHERE id = ?").run(version?.id),
      ).toThrow(/immutable/)
      const second = saveVersion(db, scope, server.id, "specVersion: 1 # v2", null)
      expect([version?.number, second?.number]).toEqual([1, 2])
    } finally {
      close()
    }
  })

  it("only appends to the audit log", () => {
    const { db, sqlite, close } = openDatabase(":memory:")
    try {
      const scope = createWorkspace(db, "w")
      recordAudit(db, scope, { type: "system" }, { action: "test" })
      expect(() => sqlite.prepare("UPDATE audit_events SET action = 'x'").run()).toThrow(
        /append-only/,
      )
      expect(() => sqlite.prepare("DELETE FROM audit_events").run()).toThrow(/append-only/)
    } finally {
      close()
    }
  })

  it("uses one default workspace for a single-tenant installation", () => {
    const { db, close } = openDatabase(":memory:")
    try {
      const first = defaultWorkspace(db)
      createWorkspace(db, "later", Date.now() + 1000)
      expect(defaultWorkspace(db).workspaceId).toBe(first.workspaceId)
    } finally {
      close()
    }
  })
})

describe("setup tokens", () => {
  it("are single use, expire, and are stored only as a hash", () => {
    const { db, sqlite, close } = openDatabase(":memory:")
    try {
      const now = 1_000_000
      const { token, expiresAt } = issueSetupToken(db, now)
      expect(expiresAt).toBe(now + SETUP_TOKEN_TTL_MS)
      const stored = JSON.stringify(sqlite.prepare("SELECT * FROM one_time_tokens").all())
      expect(stored).not.toContain(token)
      expect(stored).toContain(sha256(token))

      expect(consumeSetupToken(db, "wrong", now)).toBe(false)
      // Checking does not use it up; an expired token does not check.
      expect(setupTokenValid(db, "wrong", now)).toBe(false)
      expect(setupTokenValid(db, token, now + SETUP_TOKEN_TTL_MS)).toBe(false)
      expect(setupTokenValid(db, token, now + 1)).toBe(true)
      expect(consumeSetupToken(db, token, now + SETUP_TOKEN_TTL_MS)).toBe(false)
      expect(consumeSetupToken(db, token, now + 1)).toBe(true)
      expect(consumeSetupToken(db, token, now + 2)).toBe(false)
      expect(setupTokenValid(db, token, now + 2)).toBe(false)
    } finally {
      close()
    }
  })

  it("invalidates the previous token when a new one is issued", () => {
    const { db, close } = openDatabase(":memory:")
    try {
      const first = issueSetupToken(db, 1000).token
      const second = issueSetupToken(db, 2000).token
      expect(consumeSetupToken(db, first, 3000)).toBe(false)
      expect(consumeSetupToken(db, second, 3000)).toBe(true)
    } finally {
      close()
    }
  })
})

describe("session liveness (for playground tokens)", () => {
  it("is false once the session ended, idled out, or for another user", () => {
    const { db, close } = openDatabase(":memory:")
    try {
      const scope = defaultWorkspace(db)
      const user = (email: string) =>
        createUser(db, scope, { email, passwordHash: "unused", role: "member" }).id
      const alice = user("alice@example.test")
      const bob = user("bob@example.test")
      const now = 1_000_000
      const hash = sha256(createSession(db, scope, alice, now).id)
      expect(sessionAlive(db, hash, alice, now + 1)).toBe(true)
      // A deactivated user's session is not live, even before it is deleted.
      setDisabledAt(db, scope, alice, now)
      expect(sessionAlive(db, hash, alice, now + 1)).toBe(false)
      setDisabledAt(db, scope, alice, null)
      expect(sessionAlive(db, hash, bob, now + 1)).toBe(false)
      expect(sessionAlive(db, "unknown", alice, now + 1)).toBe(false)
      expect(sessionAlive(db, hash, alice, now + SESSION_IDLE_MS)).toBe(false)
      // Active until just before the absolute limit: still ends there.
      const end = now + SESSION_ABSOLUTE_MS
      db.update(sessions)
        .set({ lastSeenAt: end - 1 })
        .run()
      expect(sessionAlive(db, hash, alice, end - 1)).toBe(true)
      expect(sessionAlive(db, hash, alice, end)).toBe(false)
    } finally {
      close()
    }
  })
})
