import { and, asc, eq } from "drizzle-orm"
import type { Db } from "../open.js"
import { servers } from "../schema.js"
import type { WorkspaceScope } from "../scope.js"

export interface Server {
  id: string
  slug: string
  name: string
  publishedVersionId: string | null
  createdAt: number
  updatedAt: number
}

const columns = {
  id: servers.id,
  slug: servers.slug,
  name: servers.name,
  publishedVersionId: servers.publishedVersionId,
  createdAt: servers.createdAt,
  updatedAt: servers.updatedAt,
}

export function createServer(
  db: Db,
  scope: WorkspaceScope,
  input: { slug: string; name: string },
  now = Date.now(),
): Server {
  const server = {
    id: crypto.randomUUID(),
    slug: input.slug,
    name: input.name,
    publishedVersionId: null,
    createdAt: now,
    updatedAt: now,
  }
  db.insert(servers)
    .values({ ...server, workspaceId: scope.workspaceId })
    .run()
  return server
}

export function getServer(db: Db, scope: WorkspaceScope, id: string): Server | undefined {
  return db
    .select(columns)
    .from(servers)
    .where(and(eq(servers.workspaceId, scope.workspaceId), eq(servers.id, id)))
    .get()
}

export function listServers(db: Db, scope: WorkspaceScope): Server[] {
  return db
    .select(columns)
    .from(servers)
    .where(eq(servers.workspaceId, scope.workspaceId))
    .orderBy(asc(servers.createdAt), asc(servers.id))
    .all()
}

export function setPublishedVersion(
  db: Db,
  scope: WorkspaceScope,
  serverId: string,
  versionId: string,
  now = Date.now(),
): boolean {
  const result = db
    .update(servers)
    .set({ publishedVersionId: versionId, updatedAt: now })
    .where(and(eq(servers.workspaceId, scope.workspaceId), eq(servers.id, serverId)))
    .run()
  return result.changes === 1
}

export function deleteServer(db: Db, scope: WorkspaceScope, id: string): boolean {
  const result = db
    .delete(servers)
    .where(and(eq(servers.workspaceId, scope.workspaceId), eq(servers.id, id)))
    .run()
  return result.changes === 1
}
