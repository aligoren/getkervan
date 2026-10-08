import { and, desc, eq, lt, ne, or } from "drizzle-orm"
import { randomToken, sha256 } from "../../crypto.js"
import { sanitizeDisplayText } from "../../display-text.js"
import type { Db } from "../open.js"
import { sessions, users } from "../schema.js"
import { type WorkspaceScope, workspaceScope } from "../scope.js"
import type { Role, Theme } from "./users.js"

/** How much of a User-Agent is kept and shown. */
const USER_AGENT_LENGTH = 200

/**
 * A User-Agent as the session list shows it: the browser chose it (decoded as latin1, so it can
 * hold C1 controls and a soft hyphen). Hidden characters become visible escapes and backslashes
 * are doubled (display-text.ts). It is stored as sent (cut to the same length), and cleaned once,
 * here, where it leaves the database for a screen.
 */
export function displayUserAgent(userAgent: string | null | undefined): string | null {
  if (userAgent === null || userAgent === undefined) return null
  return sanitizeDisplayText(userAgent, USER_AGENT_LENGTH)
}

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
  displayName: string | null
  /** The user must change their password before using anything else (an admin reset it). */
  mustChangePassword: boolean
  theme: Theme
}

/** A session as its owner sees it: never its id or the id's hash. */
export interface SessionSummary {
  /** An opaque reference, enough to end the session and useless for anything else. */
  ref: string
  current: boolean
  createdAt: number
  lastSeenAt: number
  ip: string | null
  userAgent: string | null
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
  origin: { ip?: string | undefined; userAgent?: string | undefined } = {},
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
      ip: origin.ip?.slice(0, 64) ?? null,
      userAgent: origin.userAgent?.slice(0, USER_AGENT_LENGTH) ?? null,
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
      displayName: users.displayName,
      mustChangePassword: users.mustChangePassword,
      theme: users.theme,
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
    user: {
      id: row.userId,
      email: row.email,
      role: row.role,
      displayName: row.displayName,
      mustChangePassword: row.mustChangePassword,
      theme: row.theme,
    },
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

/** The opaque reference a session is shown and ended by (derived from the id's hash). */
export function sessionRef(idHash: string): string {
  return sha256(`kervan-session-ref:${idHash}`).slice(0, 24)
}

/** A user's live sessions, newest activity first. */
export function listSessionsOf(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  currentIdHash: string | undefined,
  now = Date.now(),
): SessionSummary[] {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.workspaceId, scope.workspaceId), eq(sessions.userId, userId)))
    .orderBy(desc(sessions.lastSeenAt))
    .all()
    .filter((row) => now < row.expiresAt && now - row.lastSeenAt < SESSION_IDLE_MS)
    .map((row) => ({
      ref: sessionRef(row.idHash),
      current: row.idHash === currentIdHash,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt,
      ip: row.ip,
      userAgent: displayUserAgent(row.userAgent),
    }))
}

/** Ends one of a user's sessions by its reference. Returns whether one ended. */
export function deleteSessionByRef(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  ref: string,
): boolean {
  const rows = db
    .select({ idHash: sessions.idHash })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, scope.workspaceId), eq(sessions.userId, userId)))
    .all()
  const match = rows.find((row) => sessionRef(row.idHash) === ref)
  if (!match) return false
  deleteSession(db, match.idHash)
  return true
}

/** Ends all of a user's sessions except one. Returns how many ended. */
export function deleteOtherSessions(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  keepIdHash: string,
): number {
  return db
    .delete(sessions)
    .where(
      and(
        eq(sessions.workspaceId, scope.workspaceId),
        eq(sessions.userId, userId),
        ne(sessions.idHash, keepIdHash),
      ),
    )
    .run().changes
}

export function countSessions(db: Db, scope: WorkspaceScope, userId: string): number {
  return db
    .select({ idHash: sessions.idHash })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, scope.workspaceId), eq(sessions.userId, userId)))
    .all().length
}
