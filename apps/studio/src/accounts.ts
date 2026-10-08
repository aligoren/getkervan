import { hashPassword, passwordProblem, randomToken, verifyPassword } from "./crypto.js"
import { type Db, writeTransaction } from "./db/open.js"
import { listActiveKeysCreatedBy, revokeApiKey } from "./db/repos/api-keys.js"
import { type Actor, recordAudit } from "./db/repos/audit.js"
import { deleteOtherSessions, sessionAlive } from "./db/repos/sessions.js"
import { consumeSetupToken, retireSetupTokens, setupTokenValid } from "./db/repos/tokens.js"
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
  THEMES,
  type Theme,
  type User,
  updateUser,
} from "./db/repos/users.js"
import { defaultWorkspace } from "./db/repos/workspaces.js"
import type { WorkspaceScope } from "./db/scope.js"
import { identitySkeleton, RESERVED_NAMES, unsafeTextProblem } from "./display-text.js"
import { isUniqueViolation, StudioError } from "./studio.js"

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/

/** Compared against when an email is unknown, so a login takes as long either way. */
let dummyHash: Promise<string> | undefined

/**
 * Computes the hash a sign-in for an unknown email is checked against. Called when the API is
 * created, so even the first unknown-account attempt takes no longer than a known one.
 */
export function prepareLoginTiming(): Promise<string> {
  dummyHash ??= hashPassword("kervan-dummy-password")
  return dummyHash
}

/** Whether `prepareLoginTiming` has run (tests). */
export function loginTimingPrepared(): boolean {
  return dummyHash !== undefined
}

/** An email people can sign in with, and that shows the same to everyone: no invisible characters. */
export function checkEmail(email: string): void {
  const unsafe = unsafeTextProblem(email, "The email")
  if (unsafe) throw new StudioError("invalid", unsafe)
  if (!EMAIL.test(email.trim())) throw new StudioError("invalid", "Enter a valid email address.")
}

function checkCredentials(email: string, password: string): void {
  checkEmail(email)
  const problem = passwordProblem(password)
  if (problem) throw new StudioError("invalid", problem)
}

/** An email may not read as another user's display name (the reverse is checked on names). */
function checkEmailNotAName(tx: Db, scope: WorkspaceScope, email: string, userId?: string): void {
  const key = identitySkeleton(email)
  const clash = listUsers(tx, scope).some(
    (other) =>
      other.id !== userId &&
      other.displayName !== null &&
      identitySkeleton(other.displayName) === key,
  )
  if (clash) {
    throw new StudioError("conflict", "That email reads like another user's display name.")
  }
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
  if (anyAdminExists(db)) throw alreadySetUp()
  if (!setupTokenValid(db, input.token)) throw invalidSetupToken()
  const passwordHash = await hashPassword(input.password)
  return writeTransaction(db, (tx) => {
    if (anyAdminExists(tx)) throw alreadySetUp()
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

/**
 * Creates the first admin from the operator's shell (`kervan-studio create-admin`): no setup token,
 * since only someone who can run commands on Studio's host and read its master key gets here.
 * The same checks as setup in the browser. Refused once any admin exists, checked again in the
 * write transaction (BEGIN IMMEDIATE), so a setup in a running Studio and this command cannot both
 * create one. Every unused setup token is retired in the same transaction: the one a running
 * Studio printed no longer works.
 */
export async function createFirstAdmin(
  db: Db,
  input: { email: string; password: string },
): Promise<{ scope: WorkspaceScope; user: User; setupTokensRetired: number }> {
  checkCredentials(input.email, input.password)
  if (anyAdminExists(db)) throw alreadySetUp()
  const passwordHash = await hashPassword(input.password)
  try {
    return writeTransaction(db, (tx) => {
      if (anyAdminExists(tx)) throw alreadySetUp()
      const setupTokensRetired = retireSetupTokens(tx)
      const scope = defaultWorkspace(tx)
      const user = createUser(tx, scope, { email: input.email, passwordHash, role: "admin" })
      recordAudit(
        tx,
        scope,
        { type: "cli" },
        {
          action: "studio.setup",
          target: { type: "user", id: user.id },
          details: { command: "create-admin", setupTokensRetired },
        },
      )
      return { scope, user, setupTokensRetired }
    })
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new StudioError("conflict", "A user with this email already exists.")
    }
    throw error
  }
}

function alreadySetUp(): StudioError {
  return new StudioError("conflict", "Studio is already set up.")
}

function invalidSetupToken(): StudioError {
  return new StudioError(
    "forbidden",
    "The setup token is invalid or has expired. Restart Studio: its console prints a new " +
      "setup token, valid for 30 minutes.",
  )
}

/**
 * Re-checked inside every admin write: the admin making it is still an active admin. The API
 * checked the role when the request came in, but a request waiting on a password hash must not
 * complete after its admin was demoted or deactivated meanwhile. (`cli` actors are the operator.)
 */
function requireActiveAdmin(tx: Db, scope: WorkspaceScope, actor: Actor): void {
  if (actor.type !== "user") return
  const admin = actor.id === undefined ? undefined : getUser(tx, scope, actor.id)
  if (admin?.role !== "admin" || admin.disabledAt !== null) {
    throw new StudioError("forbidden", "Only admins can do this.")
  }
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
    return writeTransaction(db, (tx) => {
      requireActiveAdmin(tx, scope, actor)
      checkEmailNotAName(tx, scope, input.email)
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
  return writeTransaction(db, (tx) => {
    requireActiveAdmin(tx, scope, actor)
    const user = getUser(tx, scope, userId)
    if (!user) throw new StudioError("not_found", "Not found.")
    if (disabled === (user.disabledAt !== null)) return { user, revokedKeys: [] }
    // Checked inside the write transaction (BEGIN IMMEDIATE, see writeTransaction): this relies on
    // the synchronous SQLite driver; an asynchronous driver needs this re-evaluated.
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
  const current = getUserWithHash(db, scope, userId)
  const valid =
    current !== undefined &&
    input.currentPassword.length > 0 &&
    input.currentPassword.length <= 1024 &&
    (await verifyPassword(input.currentPassword, current.passwordHash))
  if (!valid) throw new StudioError("forbidden", "The current password is wrong.")
  const problem = passwordProblem(input.newPassword)
  if (problem) throw new StudioError("invalid", problem)
  if (input.newPassword === input.currentPassword) {
    throw new StudioError("invalid", "Choose a password different from the current one.")
  }
  const passwordHash = await hashPassword(input.newPassword)
  return writeTransaction(db, (tx) => {
    // The hashes took a while: if the password changed meanwhile (an admin's reset, another
    // session's change) or this session ended, this request must not undo that.
    const unchanged = getUserWithHash(tx, scope, userId)?.passwordHash === current.passwordHash
    if (!unchanged || !sessionAlive(tx, keepSessionHash, userId)) {
      throw new StudioError(
        "conflict",
        "Your password was changed meanwhile, or this session ended. Sign in again.",
      )
    }
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
  const sessionsEnded = writeTransaction(db, (tx) => {
    requireActiveAdmin(tx, scope, actor)
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
 * the same transaction as the change, so two concurrent requests cannot both pass. All of the
 * user's sessions end (and with them their playground tokens): they sign in again under the new
 * role, so a session taken before a promotion never becomes an admin's. The caller ends their
 * open playground streams.
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
  return writeTransaction(db, (tx) => {
    requireActiveAdmin(tx, scope, actor)
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
    const sessionsEnded = deleteSessionsOf(tx, scope, user.id)
    recordAudit(tx, scope, actor, {
      action: "user.role",
      target: { type: "user", id: user.id },
      details: { from: user.role, to: role, sessionsEnded },
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
  checkEmail(email)
  const normalized = normalizeEmail(email)
  try {
    return writeTransaction(db, (tx) => {
      requireActiveAdmin(tx, scope, actor)
      const user = getUser(tx, scope, userId)
      if (!user) throw notFound()
      if (user.email === normalized) return user
      checkEmailNotAName(tx, scope, normalized, user.id)
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
  const unsafe =
    displayName === null ? undefined : unsafeTextProblem(displayName, "The display name")
  if (unsafe) throw new StudioError("invalid", unsafe)
  const key = displayName === null ? "" : identitySkeleton(displayName)
  if (displayName !== null && RESERVED_NAMES.some((name) => identitySkeleton(name) === key)) {
    throw new StudioError("invalid", `"${displayName}" is reserved: choose another display name.`)
  }
  // A name that reads as an email would let one user pass for another. Every such name is
  // refused, not only another user's email, so the answer does not reveal which accounts exist.
  if (key.includes("@")) {
    throw new StudioError("invalid", "A display name cannot be an email address.")
  }
  return writeTransaction(db, (tx) => {
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

/**
 * The signed-in user's own theme (only theirs: the API has no user id for it). A change is
 * audited; choosing the theme that is already set writes nothing.
 */
export function setTheme(
  db: Db,
  scope: WorkspaceScope,
  userId: string,
  theme: Theme,
  actor: Actor,
): Theme {
  if (!THEMES.includes(theme)) throw new StudioError("invalid", "Unknown theme.")
  return writeTransaction(db, (tx) => {
    const user = getUser(tx, scope, userId)
    if (!user) throw notFound()
    if (user.theme === theme) return theme
    updateUser(tx, scope, user.id, { theme })
    recordAudit(tx, scope, actor, {
      action: "user.theme",
      target: { type: "user", id: user.id },
      details: { from: user.theme, to: theme },
    })
    return theme
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
  const match = await matchLogin(db, scope, email, password)
  return match && stillLoggedIn(db, scope, match)
}

/** A user whose password a sign-in checked, and the hash it was checked against. */
export interface LoginMatch {
  userId: string
  passwordHash: string
}

/** Like `verifyLogin`, without the final check: pass the result to `stillLoggedIn`. */
export async function matchLogin(
  db: Db,
  scope: WorkspaceScope,
  email: string,
  password: string,
): Promise<LoginMatch | undefined> {
  if (password.length === 0 || password.length > 1024 || email.length > 320) return undefined
  const user = findUserByEmail(db, scope, email)
  const ok = await verifyPassword(password, user?.passwordHash ?? (await prepareLoginTiming()))
  // A deactivated user gets the same answer as a wrong password.
  if (!user || !ok || user.disabledAt !== null) return undefined
  return { userId: user.id, passwordHash: user.passwordHash }
}

/**
 * The user a sign-in matched, read again: `undefined` if their password changed or they were
 * deactivated while the password was being checked (a sign-in in flight must not outlive a
 * password change or a reset). Call it in the same synchronous step that starts the session.
 */
export function stillLoggedIn(db: Db, scope: WorkspaceScope, match: LoginMatch): User | undefined {
  const user = getUserWithHash(db, scope, match.userId)
  if (!user || user.disabledAt !== null || user.passwordHash !== match.passwordHash) {
    return undefined
  }
  const { passwordHash: _hash, ...rest } = user
  return rest
}
