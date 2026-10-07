import { and, eq, lt, or } from "drizzle-orm"
import { randomToken, sha256 } from "../../crypto.js"
import type { Db } from "../open.js"
import { sessions, users } from "../schema.js"
import { type WorkspaceScope, workspaceScope } from "../scope.js"
import type { Role } from "./users.js"

/** A session ends after this long without a request. */
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000
/** And after this long, however active it is. */
export const SESSION_ABSOLUTE_MS = 24 * 60 * 60 * 1000
/** `last_seen_at` is written at most this often. */
const TOUCH_INTERVAL_MS = 60 * 1000

export interface SessionUser {
  id: string
  email: string
  role: Role
}

export interface ActiveSession {
  idHash: string
  scope: WorkspaceScope
  user: SessionUser
  expiresAt: number
}

/**
 * Starts a session for a user. The returned id is the only copy (it goes into the cookie); the
 * database keeps its SHA-256.
 */
export function createSession(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  now = Date.now(),
): { id: string; expiresAt: number } {
  const id = randomToken(32)
  const expiresAt = now + SESSION_ABSOLUTE_MS
  db.insert(sessions)
    .values({
      idHash: sha256(id),
      workspaceId: scope.workspaceId,
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
    })
    .run()
  return { id, expiresAt }
}

/**
 * The live session a cookie names, or `undefined`. Like an API key, the session id is the
 * credential, so this lookup has no workspace scope: the session decides it. Expired sessions
 * are deleted on sight.
 */
export function findSession(db: Db, id: string, now = Date.now()): ActiveSession | undefined {
  if (id.length === 0 || id.length > 100) return undefined
  const idHash = sha256(id)
  const row = db
    .select({
      idHash: sessions.idHash,
      workspaceId: sessions.workspaceId,
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      email: users.email,
      role: users.role,
      userWorkspaceId: users.workspaceId,
      disabledAt: users.disabledAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.idHash, idHash))
    .get()
  if (!row) return undefined
  const expired = now >= row.expiresAt || now - row.lastSeenAt >= SESSION_IDLE_MS
  if (expired || row.disabledAt !== null || row.userWorkspaceId !== row.workspaceId) {
    deleteSession(db, idHash)
    return undefined
  }
  if (now - row.lastSeenAt >= TOUCH_INTERVAL_MS) {
    db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.idHash, idHash)).run()
  }
  return {
    idHash,
    scope: workspaceScope(row.workspaceId),
    user: { id: row.userId, email: row.email, role: row.role },
    expiresAt: row.expiresAt,
  }
}

/**
 * Whether a session is still live for a user, by its hash (for credentials derived from a
 * session, like playground tokens). Does not count as activity.
 */
export function sessionAlive(db: Db, idHash: string, userId: string, now = Date.now()): boolean {
  const row = db
    .select({
      lastSeenAt: sessions.lastSeenAt,
      expiresAt: sessions.expiresAt,
      disabledAt: users.disabledAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.idHash, idHash), eq(sessions.userId, userId)))
    .get()
  return (
    row !== undefined &&
    row.disabledAt === null &&
    now < row.expiresAt &&
    now - row.lastSeenAt < SESSION_IDLE_MS
  )
}

export function deleteSession(db: Db, idHash: string): void {
  db.delete(sessions).where(eq(sessions.idHash, idHash)).run()
}

/** Removes sessions that can no longer be used. Returns how many were removed. */
export function deleteExpiredSessions(db: Db, now = Date.now()): number {
  return db
    .delete(sessions)
    .where(or(lt(sessions.expiresAt, now + 1), lt(sessions.lastSeenAt, now - SESSION_IDLE_MS + 1)))
    .run().changes
}

export function countSessions(db: Db, scope: WorkspaceScope, userId: string): number {
  return db
    .select({ idHash: sessions.idHash })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, scope.workspaceId), eq(sessions.userId, userId)))
    .all().length
}
