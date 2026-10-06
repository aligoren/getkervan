import { asc } from "drizzle-orm"
import type { Db } from "../open.js"
import { workspaces } from "../schema.js"
import { type WorkspaceScope, workspaceScope } from "../scope.js"

export function createWorkspace(db: Db, name: string, now = Date.now()): WorkspaceScope {
  const id = crypto.randomUUID()
  db.insert(workspaces).values({ id, name, createdAt: now }).run()
  return workspaceScope(id)
}

/**
 * The workspace of a single-tenant installation: the oldest one, created on first start.
 * A multi-tenant deployment would pick the workspace from the verified user instead.
 */
export function defaultWorkspace(db: Db): WorkspaceScope {
  const first = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
    .limit(1)
    .get()
  return first ? workspaceScope(first.id) : createWorkspace(db, "Default")
}
