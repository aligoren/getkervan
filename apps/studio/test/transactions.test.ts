// Check-then-write operations take SQLite's write lock when they begin (BEGIN IMMEDIATE), so a
// second writer, in this process or another one on the same file, waits and then sees the new
// state instead of acting on a stale snapshot.
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  changeOwnPassword,
  resetPassword,
  setUserDisabled,
  setUserEmail,
  setUserRole,
  setupAdmin,
} from "../src/accounts.js"
import { hashPassword, sha256 } from "../src/crypto.js"
import { type OpenedDatabase, openDatabase } from "../src/db/open.js"
import { createServer } from "../src/db/repos/servers.js"
import { createSession } from "../src/db/repos/sessions.js"
import { issueSetupToken } from "../src/db/repos/tokens.js"
import { countActiveAdmins, createUser } from "../src/db/repos/users.js"
import { saveVersion } from "../src/db/repos/versions.js"
import { defaultWorkspace } from "../src/db/repos/workspaces.js"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const PASSWORD = "correct horse battery staple"
const actor = { type: "cli" as const }

/** Records which kind of transaction each better-sqlite3 transaction call used. */
function recordTransactions(opened: OpenedDatabase): string[] {
  const used: string[] = []
  const sqlite = opened.sqlite
  const original = sqlite.transaction.bind(sqlite)
  sqlite.transaction = ((fn: (...args: unknown[]) => unknown) =>
    new Proxy(original(fn), {
      get(target, property, receiver) {
        if (property === "deferred" || property === "immediate" || property === "exclusive") {
          used.push(property)
        }
        return Reflect.get(target, property, receiver)
      },
    })) as typeof sqlite.transaction
  return used
}

function fileDatabase(): { file: string; open: () => OpenedDatabase } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kervan-tx-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, "studio.db")
  return {
    file,
    open: () => {
      const opened = openDatabase(file)
      cleanups.push(() => opened.close())
      return opened
    },
  }
}

describe("check-then-write operations", () => {
  it("all begin with BEGIN IMMEDIATE", async () => {
    const opened = openDatabase(":memory:")
    cleanups.push(() => opened.close())
    const db = opened.db
    const scope = defaultWorkspace(db)
    const passwordHash = await hashPassword(PASSWORD)
    const used = recordTransactions(opened)

    const { token } = issueSetupToken(db)
    const { user: owner } = await setupAdmin(
      db,
      { token, email: "owner@example.test", password: PASSWORD },
      undefined,
    )
    const second = createUser(db, scope, { email: "b@example.test", passwordHash, role: "admin" })
    const member = createUser(db, scope, { email: "m@example.test", passwordHash, role: "member" })
    used.length = 0

    setUserDisabled(db, scope, second.id, true, actor)
    setUserRole(db, scope, member.id, "admin", actor)
    setUserEmail(db, scope, member.id, "renamed@example.test", actor)
    // After the role change, which ends the user's sessions.
    const session = createSession(db, scope, member.id)
    await changeOwnPassword(
      db,
      scope,
      member.id,
      { currentPassword: PASSWORD, newPassword: "another long password" },
      sha256(session.id),
      actor,
    )
    await resetPassword(db, scope, member.id, {}, { type: "user", id: owner.id })
    const server = createServer(db, scope, { slug: "s", name: "S" })
    saveVersion(db, scope, server.id, "specVersion: 1", null)

    expect(used.length).toBeGreaterThanOrEqual(6)
    expect(
      used.every((kind) => kind === "immediate"),
      used.join(","),
    ).toBe(true)
  })

  it("fail closed while another connection to the same file holds the write lock", async () => {
    const { open } = fileDatabase()
    const a = open()
    const b = open()
    const scope = defaultWorkspace(a.db)
    const passwordHash = await hashPassword(PASSWORD)
    createUser(a.db, scope, { email: "one@example.test", passwordHash, role: "admin" })
    const two = createUser(a.db, scope, { email: "two@example.test", passwordHash, role: "admin" })

    // Another Studio process is in the middle of its own write.
    b.sqlite.prepare("BEGIN IMMEDIATE").run()
    a.sqlite.pragma("busy_timeout = 50")
    expect(() => setUserDisabled(a.db, scope, two.id, true, actor)).toThrow(/locked|busy/i)
    expect(countActiveAdmins(a.db, scope)).toBe(2)

    // Once it commits, this one goes ahead, reading the state that commit left.
    b.sqlite.prepare("COMMIT").run()
    setUserDisabled(a.db, scope, two.id, true, actor)
    expect(countActiveAdmins(b.db, scope)).toBe(1)
  })

  it("let the second of two connections see the first one's change before checking", async () => {
    const { open } = fileDatabase()
    const a = open()
    const b = open()
    const scope = defaultWorkspace(a.db)
    const passwordHash = await hashPassword(PASSWORD)
    const one = createUser(a.db, scope, { email: "one@example.test", passwordHash, role: "admin" })
    const two = createUser(a.db, scope, { email: "two@example.test", passwordHash, role: "admin" })
    // A reader on B started before A's change (a deferred transaction would keep this snapshot).
    b.sqlite.prepare("BEGIN").run()
    expect(countActiveAdmins(b.db, scope)).toBe(2)
    b.sqlite.prepare("COMMIT").run()
    setUserDisabled(a.db, scope, one.id, true, actor)
    // B's check runs in a new IMMEDIATE transaction: it sees one active admin and refuses.
    expect(() => setUserDisabled(b.db, scope, two.id, true, actor)).toThrow(/last active admin/)
    expect(countActiveAdmins(a.db, scope)).toBe(1)
  })
})
