import { and, eq } from "drizzle-orm"
import type { Db } from "../open.js"
import { sessions, users } from "../schema.js"
import type { WorkspaceScope } from "../scope.js"

export type Role = "admin" | "member"

export interface User {
  id: string
  email: string
  role: Role
  createdAt: number
}

const publicColumns = {
  id: users.id,
  email: users.email,
  role: users.role,
  createdAt: users.createdAt,
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
  return { id: user.id, email: user.email, role: user.role, createdAt: now }
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

export function listAdmins(db: Db, scope: WorkspaceScope): User[] {
  return db
    .select(publicColumns)
    .from(users)
    .where(and(eq(users.workspaceId, scope.workspaceId), eq(users.role, "admin")))
    .orderBy(users.createdAt)
    .all()
}

export function setPasswordHash(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  passwordHash: string,
  now = Date.now(),
): boolean {
  const result = db
    .update(users)
    .set({ passwordHash, updatedAt: now })
    .where(and(eq(users.workspaceId, scope.workspaceId), eq(users.id, userId)))
    .run()
  return result.changes === 1
}

/** Signs the user out everywhere. Returns how many sessions ended. */
export function deleteSessionsOf(db: Db, scope: WorkspaceScope, userId: string): number {
  return db
    .delete(sessions)
    .where(and(eq(sessions.workspaceId, scope.workspaceId), eq(sessions.userId, userId)))
    .run().changes
}
