import { and, desc, eq, max } from "drizzle-orm"
import { sha256 } from "../../crypto.js"
import type { Db } from "../open.js"
import { servers, specVersions } from "../schema.js"
import type { WorkspaceScope } from "../scope.js"

export interface SpecVersion {
  id: string
  serverId: string
  number: number
  yamlText: string
  sha256: string
  createdBy: string | null
  createdAt: number
}

const columns = {
  id: specVersions.id,
  serverId: specVersions.serverId,
  number: specVersions.number,
  yamlText: specVersions.yamlText,
  sha256: specVersions.sha256,
  createdBy: specVersions.createdBy,
  createdAt: specVersions.createdAt,
}

/**
 * Saves a new immutable version of a server's spec, numbered after the last one. Returns
 * `undefined` if the server is not in this workspace.
 */
export function saveVersion(
  db: Db,
  scope: WorkspaceScope,
  serverId: string,
  yamlText: string,
  createdBy: string | null,
  now = Date.now(),
): SpecVersion | undefined {
  return db.transaction((tx) => {
    const server = tx
      .select({ id: servers.id })
      .from(servers)
      .where(and(eq(servers.workspaceId, scope.workspaceId), eq(servers.id, serverId)))
      .get()
    if (!server) return undefined
    const last = tx
      .select({ number: max(specVersions.number) })
      .from(specVersions)
      .where(eq(specVersions.serverId, serverId))
      .get()
    const version: SpecVersion = {
      id: crypto.randomUUID(),
      serverId,
      number: (last?.number ?? 0) + 1,
      yamlText,
      sha256: sha256(yamlText),
      createdBy,
      createdAt: now,
    }
    tx.insert(specVersions)
      .values({ ...version, workspaceId: scope.workspaceId })
      .run()
    return version
  })
}

/** A version of `serverId` in this workspace, or `undefined`. */
export function getVersion(
  db: Db,
  scope: WorkspaceScope,
  serverId: string,
  versionId: string,
): SpecVersion | undefined {
  return db
    .select(columns)
    .from(specVersions)
    .where(
      and(
        eq(specVersions.workspaceId, scope.workspaceId),
        eq(specVersions.serverId, serverId),
        eq(specVersions.id, versionId),
      ),
    )
    .get()
}

export function listVersions(db: Db, scope: WorkspaceScope, serverId: string): SpecVersion[] {
  return db
    .select(columns)
    .from(specVersions)
    .where(
      and(eq(specVersions.workspaceId, scope.workspaceId), eq(specVersions.serverId, serverId)),
    )
    .orderBy(desc(specVersions.number))
    .all()
}
