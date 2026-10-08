import type { Db } from "./db/open.js"
import type { Actor } from "./db/repos/audit.js"
import { getUser } from "./db/repos/users.js"
import type { WorkspaceScope } from "./db/scope.js"
import { StudioError } from "./studio.js"

/**
 * Checks again, inside a write transaction (BEGIN IMMEDIATE), what the API checked when the
 * request came in (`actor.requires`): the actor is still an active user, and still an admin if
 * the request needed one. A request waits after that first check (for its body, a password hash,
 * a spec load); meanwhile an admin may have demoted or deactivated the actor, and the write must
 * not happen. Actors without `requires` (the command line, Studio itself, tests) are not checked.
 */
export function requireActor(tx: Db, scope: WorkspaceScope, actor: Actor): void {
  if (actor.requires === undefined) return
  const user = actor.type === "user" && actor.id ? getUser(tx, scope, actor.id) : undefined
  if (!user || user.disabledAt !== null) {
    throw new StudioError("forbidden", "Your account is no longer active. Sign in again.")
  }
  if (actor.requires === "admin" && user.role !== "admin") {
    throw new StudioError("forbidden", "Only admins can do this.")
  }
}
