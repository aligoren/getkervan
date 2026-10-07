import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import Database from "better-sqlite3"
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3"
import { migrate } from "drizzle-orm/better-sqlite3/migrator"
import { readMigrationFiles } from "drizzle-orm/migrator"
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core"
import * as schema from "./schema.js"

/** The database or a transaction on it: repositories accept both. */
export type Db = BaseSQLiteDatabase<"sync", Database.RunResult, typeof schema>

export interface OpenedDatabase {
  db: BetterSQLite3Database<typeof schema>
  sqlite: Database.Database
  close(): void
}

export class DatabaseError extends Error {
  override name = "DatabaseError"
}

/**
 * Runs `fn` in a write transaction that takes SQLite's write lock when it begins (BEGIN
 * IMMEDIATE). A check and the write that depends on it (the last active admin, a free email, a
 * setup token) then see the same state, even when another Studio process uses the same database
 * file: a second writer waits for the lock (busy_timeout) and then reads the new state, instead
 * of working on a snapshot that went stale.
 *
 * This relies on better-sqlite3 being synchronous: nothing else in this process runs between the
 * check and the write. Moving to an asynchronous driver means re-evaluating every caller.
 */
export function writeTransaction<T>(db: Db, fn: (tx: Db) => T): T {
  return db.transaction(fn, { behavior: "immediate" })
}

/** The migrations shipped with Studio: `apps/studio/drizzle`, next to `src` and `dist`. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url))

const BUSY_TIMEOUT_MS = 5_000

/**
 * Opens (creating if needed) the Studio database and brings its schema up to date. Refuses to
 * open when a migration fails or when the database was written by a newer Studio.
 *
 * On POSIX systems the data directory is made owner-only (0700) and the database files 0600;
 * on Windows they inherit the directory's ACL (keep the data directory in a private location).
 */
export function openDatabase(
  file: string,
  options: { migrationsFolder?: string } = {},
): OpenedDatabase {
  const memory = file === ":memory:"
  if (!memory) prepareFiles(file)
  let sqlite: Database.Database
  try {
    sqlite = new Database(file)
  } catch (error) {
    throw new DatabaseError(`Could not open the database ${file}: ${(error as Error).message}`)
  }
  try {
    const mode = sqlite.pragma("journal_mode = WAL", { simple: true })
    if (!memory && mode !== "wal") {
      throw new DatabaseError(`The database could not switch to WAL mode (got "${String(mode)}").`)
    }
    sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
    sqlite.pragma("foreign_keys = ON")
    sqlite.pragma("synchronous = NORMAL")
    const db = drizzle(sqlite, { schema })
    const migrationsFolder = options.migrationsFolder ?? MIGRATIONS_FOLDER
    try {
      migrate(db, { migrationsFolder })
    } catch (error) {
      const cause = (error as { cause?: unknown }).cause
      const detail = cause instanceof Error ? cause.message : (error as Error).message
      throw new DatabaseError(`A database migration failed; Studio will not start: ${detail}`)
    }
    const known = readMigrationFiles({ migrationsFolder }).length
    const applied = sqlite.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as {
      n: number
    }
    if (applied.n > known) {
      throw new DatabaseError(
        "The database was created by a newer version of Kervan Studio; upgrade Studio to open it.",
      )
    }
    if (!memory) restrictFiles(file)
    return { db, sqlite, close: () => sqlite.close() }
  } catch (error) {
    sqlite.close()
    throw error
  }
}

/** Creates the directory and the file with owner-only permissions before SQLite opens them. */
function prepareFiles(file: string): void {
  const dir = path.dirname(path.resolve(file))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") chmodSync(dir, 0o700)
  // SQLite creates the -wal and -shm files with the database file's permissions.
  closeSync(openSync(file, "a", 0o600))
  if (process.platform !== "win32") chmodSync(file, 0o600)
}

function restrictFiles(file: string): void {
  if (process.platform === "win32") return
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(file + suffix)) chmodSync(file + suffix, 0o600)
  }
}
