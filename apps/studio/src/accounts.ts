import { hashPassword, passwordProblem, verifyPassword } from "./crypto.js"
import type { Db } from "./db/open.js"
import { listActiveKeysCreatedBy, revokeApiKey } from "./db/repos/api-keys.js"
import { type Actor, recordAudit } from "./db/repos/audit.js"
import { consumeSetupToken, setupTokenValid } from "./db/repos/tokens.js"
import {
  anyAdminExists,
  countActiveAdmins,
  createUser,
  deleteSessionsOf,
  findUserByEmail,
  getUser,
  listUsers,
  type Role,
  setDisabledAt,
  type User,
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
