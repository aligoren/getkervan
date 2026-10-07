import { hashPassword, passwordProblem, randomToken, verifyPassword } from "./crypto.js"
import type { Db } from "./db/open.js"
import { listActiveKeysCreatedBy, revokeApiKey } from "./db/repos/api-keys.js"
import { type Actor, recordAudit } from "./db/repos/audit.js"
import { deleteOtherSessions } from "./db/repos/sessions.js"
import { consumeSetupToken, setupTokenValid } from "./db/repos/tokens.js"
import {
  anyAdminExists,
  countActiveAdmins,
  createUser,
  deleteSessionsOf,
  findUserByEmail,
  getUser,
  getUserWithHash,
  listUsers,
  normalizeEmail,
  type Role,
  setDisabledAt,
  setPasswordHash,
  type User,
  updateUser,
} from "./db/repos/users.js"
import { defaultWorkspace } from "./db/repos/workspaces.js"
import type { WorkspaceScope } from "./db/scope.js"
import { isUniqueViolation, StudioError } from "./studio.js"

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/

/** Compared against when an email is unknown, so a login takes as long either way. */
let dummyHash: Promise<string> | undefined

function checkCredentials(email: string, password: string): void {
  if (!EMAIL.test(email.trim())) throw new StudioError("invalid", "Enter a valid email address.")
  const problem = passwordProblem(password)
  if (problem) throw new StudioError("invalid", problem)
}

/**
 * Creates the first admin with the setup token printed at startup. The token is consumed in the
 * same transaction, and setup is refused once any admin exists, so one token makes one admin.
 */
export async function setupAdmin(
  db: Db,
  input: { token: string; email: string; password: string },
  ip: string | undefined,
): Promise<{ scope: WorkspaceScope; user: User }> {
  checkCredentials(input.email, input.password)
  // Checked before the (slow) password hash, and again when the token is used below.
  if (anyAdminExists(db)) throw new StudioError("conflict", "Studio is already set up.")
  if (!setupTokenValid(db, input.token)) throw invalidSetupToken()
  const passwordHash = await hashPassword(input.password)
  return db.transaction((tx) => {
    if (anyAdminExists(tx)) throw new StudioError("conflict", "Studio is already set up.")
    if (!consumeSetupToken(tx, input.token)) throw invalidSetupToken()
    const scope = defaultWorkspace(tx)
    const user = createUser(tx, scope, { email: input.email, passwordHash, role: "admin" })
    recordAudit(
      tx,
      scope,
      { type: "user", id: user.id, ip },
      {
        action: "studio.setup",
        target: { type: "user", id: user.id },
      },
    )
    return { scope, user }
  })
}

function invalidSetupToken(): StudioError {
  return new StudioError("forbidden", "The setup token is invalid or has expired.")
}

/** Adds a user to the workspace (admins only; the API checks the role). */
export async function addUser(
  db: Db,
  scope: WorkspaceScope,
  input: { email: string; password: string; role: Role },
  actor: Actor,
): Promise<User> {
  checkCredentials(input.email, input.password)
  if (input.role !== "admin" && input.role !== "member") {
    throw new StudioError("invalid", 'The role must be "admin" or "member".')
  }
  const passwordHash = await hashPassword(input.password)
  try {
    return db.transaction((tx) => {
      const user = createUser(tx, scope, { email: input.email, passwordHash, role: input.role })
      recordAudit(tx, scope, actor, {
        action: "user.create",
        target: { type: "user", id: user.id },
        details: { role: user.role },
      })
      return user
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new StudioError("conflict", "A user with this email already exists.")
    }
    throw error
  }
}

export { listUsers }

/** The active API keys a user created (admins look before deactivating the user). */
export function userApiKeys(db: Db, scope: WorkspaceScope, userId: string) {
  if (!getUser(db, scope, userId)) throw new StudioError("not_found", "Not found.")
  return listActiveKeysCreatedBy(db, scope, userId)
}

/**
 * Deactivates or reactivates a user (admins only; the API checks the role). Deactivating ends
 * the user's sessions, and with them their playground tokens, at once. With `revokeKeys`, the
 * API keys the user created are revoked in the same transaction (each one audited); the caller
 * ends their open streams with the returned ids. Reactivating does not bring keys back. The
 * last active admin cannot be deactivated, so someone can always manage Studio.
 */
export function setUserDisabled(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  disabled: boolean,
  actor: Actor,
  options: { revokeKeys?: boolean } = {},
): { user: User; revokedKeys: string[] } {
  if (options.revokeKeys && !disabled) {
    throw new StudioError("invalid", "Keys are revoked only when deactivating a user.")
  }
  return db.transaction((tx) => {
    const user = getUser(tx, scope, userId)
    if (!user) throw new StudioError("not_found", "Not found.")
    if (disabled === (user.disabledAt !== null)) return { user, revokedKeys: [] }
    if (disabled && user.role === "admin" && countActiveAdmins(tx, scope, user.id) === 0) {
      throw new StudioError("conflict", "The last active admin cannot be deactivated.")
    }
    const disabledAt = disabled ? Date.now() : null
    setDisabledAt(tx, scope, user.id, disabledAt)
    const sessionsEnded = disabled ? deleteSessionsOf(tx, scope, user.id) : 0
    const revokedKeys: string[] = []
    if (options.revokeKeys) {
      for (const key of listActiveKeysCreatedBy(tx, scope, user.id)) {
        if (!revokeApiKey(tx, scope, key.id)) continue
        revokedKeys.push(key.id)
        recordAudit(tx, scope, actor, {
          action: "api_key.revoke",
          target: { type: "api_key", id: key.id },
          details: { serverId: key.serverId, prefix: key.prefix, reason: "user.disable" },
        })
      }
    }
    recordAudit(tx, scope, actor, {
      action: disabled ? "user.disable" : "user.enable",
      target: { type: "user", id: user.id },
      ...(disabled ? { details: { sessionsEnded, keysRevoked: revokedKeys.length } } : {}),
    })
    return { user: { ...user, disabledAt }, revokedKeys }
  })
}

/** Whether `password` is the user's current password (callers throttle the attempts). */
export async function checkPassword(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  password: string,
): Promise<boolean> {
  const user = getUserWithHash(db, scope, userId)
  if (!user || password.length === 0 || password.length > 1024) return false
  return verifyPassword(password, user.passwordHash)
}

/**
 * Changes the signed-in user's own password. The current password is required (the caller
 * throttles wrong ones like failed logins). Every other session of the user ends, and with them
 * their playground tokens; the session that made the change stays.
 */
export async function changeOwnPassword(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  input: { currentPassword: string; newPassword: string },
  keepSessionHash: string,
  actor: Actor,
): Promise<{ sessionsEnded: number }> {
  if (!(await checkPassword(db, scope, userId, input.currentPassword))) {
    throw new StudioError("forbidden", "The current password is wrong.")
  }
  const problem = passwordProblem(input.newPassword)
  if (problem) throw new StudioError("invalid", problem)
  if (input.newPassword === input.currentPassword) {
    throw new StudioError("invalid", "Choose a password different from the current one.")
  }
  const passwordHash = await hashPassword(input.newPassword)
  return db.transaction((tx) => {
    if (!setPasswordHash(tx, scope, userId, passwordHash)) throw notFound()
    const sessionsEnded = deleteOtherSessions(tx, scope, userId, keepSessionHash)
    recordAudit(tx, scope, actor, {
      action: "user.password_change",
      target: { type: "user", id: userId },
      details: { sessionsEnded },
    })
    return { sessionsEnded }
  })
}

/**
 * An admin sets a temporary password for another user (given, or generated and returned once).
 * All of the user's sessions end, and they must choose a new password at their next sign-in.
 * The caller checks the admin's own password first (and throttles it like a login).
 */
export async function resetPassword(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  input: { password?: string | undefined },
  actor: Actor,
): Promise<{ temporaryPassword: string | undefined; sessionsEnded: number }> {
  if (actor.id === userId) {
    throw new StudioError("invalid", "Change your own password on your profile page.")
  }
  if (!getUser(db, scope, userId)) throw notFound()
  const generated = input.password === undefined || input.password === ""
  const password = generated ? randomToken(18) : (input.password ?? "")
  const problem = passwordProblem(password)
  if (problem) throw new StudioError("invalid", problem)
  const passwordHash = await hashPassword(password)
  const sessionsEnded = db.transaction((tx) => {
    if (!setPasswordHash(tx, scope, userId, passwordHash, Date.now(), true)) throw notFound()
    const ended = deleteSessionsOf(tx, scope, userId)
    recordAudit(tx, scope, actor, {
      action: "user.password_reset",
      target: { type: "user", id: userId },
      details: { sessionsEnded: ended, generated },
    })
    return ended
  })
  // A generated password is in this response only; a given one is never echoed.
  return { temporaryPassword: generated ? password : undefined, sessionsEnded }
}

/**
 * Changes a user's role (admins only). The last active admin cannot become a member, checked in
 * the same transaction as the change, so two concurrent requests cannot both pass.
 */
export function setUserRole(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  role: Role,
  actor: Actor,
): User {
  if (role !== "admin" && role !== "member") {
    throw new StudioError("invalid", 'The role must be "admin" or "member".')
  }
  return db.transaction((tx) => {
    const user = getUser(tx, scope, userId)
    if (!user) throw notFound()
    if (user.role === role) return user
    const lastAdmin =
      user.role === "admin" &&
      user.disabledAt === null &&
      countActiveAdmins(tx, scope, user.id) === 0
    if (lastAdmin) {
      throw new StudioError("conflict", "The last active admin cannot stop being an admin.")
    }
    updateUser(tx, scope, user.id, { role })
    recordAudit(tx, scope, actor, {
      action: "user.role",
      target: { type: "user", id: user.id },
      details: { from: user.role, to: role },
    })
    return { ...user, role }
  })
}

/**
 * Changes a user's email (admins only). Emails are unique per workspace, compared
 * case-insensitively. The admin is told about a clash; the sign-in page still says nothing.
 */
export function setUserEmail(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  email: string,
  actor: Actor,
): User {
  if (!EMAIL.test(email.trim())) throw new StudioError("invalid", "Enter a valid email address.")
  const normalized = normalizeEmail(email)
  try {
    return db.transaction((tx) => {
      const user = getUser(tx, scope, userId)
      if (!user) throw notFound()
      if (user.email === normalized) return user
      updateUser(tx, scope, user.id, { email: normalized })
      recordAudit(tx, scope, actor, {
        action: "user.email",
        target: { type: "user", id: user.id },
        details: { from: user.email, to: normalized },
      })
      return { ...user, email: normalized }
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new StudioError("conflict", "Another user already has this email.")
    }
    throw error
  }
}

/** The signed-in user's own profile fields (only the display name can change). */
export function updateProfile(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  input: { displayName: string | null },
  actor: Actor,
): User {
  const displayName = input.displayName?.trim() || null
  if (displayName !== null && displayName.length > 100) {
    throw new StudioError("invalid", "The display name can be at most 100 characters.")
  }
  return db.transaction((tx) => {
    const user = getUser(tx, scope, userId)
    if (!user) throw notFound()
    updateUser(tx, scope, user.id, { displayName })
    recordAudit(tx, scope, actor, {
      action: "user.profile",
      target: { type: "user", id: user.id },
    })
    return { ...user, displayName }
  })
}

function notFound(): StudioError {
  return new StudioError("not_found", "Not found.")
}

/**
 * The user these credentials belong to, or `undefined`. Unknown emails cost the same password
 * check as known ones, so timing does not reveal which accounts exist.
 */
export async function verifyLogin(
  db: Db,
  scope: WorkspaceScope,
  email: string,
  password: string,
): Promise<User | undefined> {
  if (password.length === 0 || password.length > 1024 || email.length > 320) return undefined
  const user = findUserByEmail(db, scope, email)
  dummyHash ??= hashPassword("kervan-dummy-password")
  const ok = await verifyPassword(password, user?.passwordHash ?? (await dummyHash))
  // A deactivated user gets the same answer as a wrong password.
  if (!user || !ok || user.disabledAt !== null) return undefined
  const { passwordHash: _hash, ...rest } = user
  return rest
}
