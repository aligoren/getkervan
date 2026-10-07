import { and, eq, isNull, ne } from "drizzle-orm"
import type { Db } from "../open.js"
import { sessions, users } from "../schema.js"
import type { WorkspaceScope } from "../scope.js"

export type Role = "admin" | "member"

export interface User {
  id: string
  email: string
  role: Role
  createdAt: number
  /** Set while the user is deactivated. */
  disabledAt: number | null
  displayName: string | null
  /** Set after an admin's password reset, until the user picks a new password. */
  mustChangePassword: boolean
  lastLoginAt: number | null
}

const publicColumns = {
  id: users.id,
  email: users.email,
  role: users.role,
  createdAt: users.createdAt,
  disabledAt: users.disabledAt,
  displayName: users.displayName,
  mustChangePassword: users.mustChangePassword,
  lastLoginAt: users.lastLoginAt,
}

/** Email addresses are compared case-insensitively and without surrounding spaces. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function createUser(
  db: Db,
  scope: WorkspaceScope,
  input: { email: string; passwordHash: string; role: Role },
  now = Date.now(),
): User {
  const user = {
    id: crypto.randomUUID(),
    workspaceId: scope.workspaceId,
    email: normalizeEmail(input.email),
    passwordHash: input.passwordHash,
    role: input.role,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(users).values(user).run()
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    createdAt: now,
    disabledAt: null,
    displayName: null,
    mustChangePassword: false,
    lastLoginAt: null,
  }
}

export function findUserByEmail(
  db: Db,
  scope: WorkspaceScope,
  email: string,
): (User & { passwordHash: string }) | undefined {
  return db
    .select({ ...publicColumns, passwordHash: users.passwordHash })
    .from(users)
    .where(and(eq(users.workspaceId, scope.workspaceId), eq(users.email, normalizeEmail(email))))
    .get()
}

/** A user with their password hash (to check a current password). */
export function getUserWithHash(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
): (User & { passwordHash: string }) | undefined {
  return db
    .select({ ...publicColumns, passwordHash: users.passwordHash })
    .from(users)
    .where(and(eq(users.workspaceId, scope.workspaceId), eq(users.id, userId)))
    .get()
}

export function listAdmins(db: Db, scope: WorkspaceScope): User[] {
  return db
    .select(publicColumns)
    .from(users)
    .where(and(eq(users.workspaceId, scope.workspaceId), eq(users.role, "admin")))
    .orderBy(users.createdAt)
    .all()
}

/** Sets a new password hash; `mustChange` marks it as temporary (an admin's reset). */
export function setPasswordHash(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  passwordHash: string,
  now = Date.now(),
  mustChange = false,
): boolean {
  const result = db
    .update(users)
    .set({ passwordHash, mustChangePassword: mustChange, updatedAt: now })
    .where(and(eq(users.workspaceId, scope.workspaceId), eq(users.id, userId)))
    .run()
  return result.changes === 1
}

export function getUser(db: Db, scope: WorkspaceScope, userId: string): User | undefined {
  return db
    .select(publicColumns)
    .from(users)
    .where(and(eq(users.workspaceId, scope.workspaceId), eq(users.id, userId)))
    .get()
}

/** Deactivates (a time) or reactivates (`null`) a user. */
export function setDisabledAt(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  disabledAt: number | null,
  now = Date.now(),
): boolean {
  const result = db
    .update(users)
    .set({ disabledAt, updatedAt: now })
    .where(and(eq(users.workspaceId, scope.workspaceId), eq(users.id, userId)))
    .run()
  return result.changes === 1
}

/** Updates the fields an admin or the user may change. */
export function updateUser(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  fields: { role?: Role; email?: string; displayName?: string | null },
  now = Date.now(),
): boolean {
  const result = db
    .update(users)
    .set({
      ...(fields.role === undefined ? {} : { role: fields.role }),
      ...(fields.email === undefined ? {} : { email: normalizeEmail(fields.email) }),
      ...(fields.displayName === undefined ? {} : { displayName: fields.displayName }),
      updatedAt: now,
    })
    .where(and(eq(users.workspaceId, scope.workspaceId), eq(users.id, userId)))
    .run()
  return result.changes === 1
}

export function recordLogin(db: Db, scope: WorkspaceScope, userId: string, now = Date.now()) {
  db.update(users)
    .set({ lastLoginAt: now })
    .where(and(eq(users.workspaceId, scope.workspaceId), eq(users.id, userId)))
    .run()
}

/** How many admins of the workspace are active, not counting `except`. */
export function countActiveAdmins(db: Db, scope: WorkspaceScope, except?: string): number {
  return db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.workspaceId, scope.workspaceId),
        eq(users.role, "admin"),
        isNull(users.disabledAt),
        except === undefined ? undefined : ne(users.id, except),
      ),
    )
    .all().length
}

/** Signs the user out everywhere. Returns how many sessions ended. */
export function deleteSessionsOf(db: Db, scope: WorkspaceScope, userId: string): number {
  return db
    .delete(sessions)
    .where(and(eq(sessions.workspaceId, scope.workspaceId), eq(sessions.userId, userId)))
    .run().changes
}

export function listUsers(db: Db, scope: WorkspaceScope): User[] {
  return db
    .select(publicColumns)
    .from(users)
    .where(eq(users.workspaceId, scope.workspaceId))
    .orderBy(users.createdAt)
    .all()
}

/** Whether any workspace has an admin (setup is over once one does). */
export function anyAdminExists(db: Db): boolean {
  return (
    db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1).get() !==
    undefined
  )
}
