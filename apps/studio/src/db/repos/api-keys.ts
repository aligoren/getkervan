import { and, eq, isNull } from "drizzle-orm"
import { randomToken, sha256 } from "../../crypto.js"
import type { Db } from "../open.js"
import { apiKeys, servers } from "../schema.js"
import { type WorkspaceScope, workspaceScope } from "../scope.js"

/** `kvn_` and 32 random bytes in base64url. */
export const API_KEY_PATTERN = /^kvn_[A-Za-z0-9_-]{43}$/
const PREFIX_LENGTH = 12

export interface ApiKeyInfo {
  id: string
  serverId: string
  name: string
  prefix: string
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

const infoColumns = {
  id: apiKeys.id,
  serverId: apiKeys.serverId,
  name: apiKeys.name,
  prefix: apiKeys.prefix,
  createdAt: apiKeys.createdAt,
  lastUsedAt: apiKeys.lastUsedAt,
  revokedAt: apiKeys.revokedAt,
}

/**
 * Creates a key for one server. The returned `key` is the only copy: only its hash is stored.
 * Returns `undefined` if the server is not in this workspace.
 */
export function createApiKey(
  db: Db,
  scope: WorkspaceScope,
  input: { serverId: string; name: string; createdBy: string | null },
  now = Date.now(),
): { info: ApiKeyInfo; key: string } | undefined {
  const server = db
    .select({ id: servers.id })
    .from(servers)
    .where(and(eq(servers.workspaceId, scope.workspaceId), eq(servers.id, input.serverId)))
    .get()
  if (!server) return undefined
  const key = `kvn_${randomToken(32)}`
  const info: ApiKeyInfo = {
    id: crypto.randomUUID(),
    serverId: input.serverId,
    name: input.name,
    prefix: key.slice(0, PREFIX_LENGTH),
    createdAt: now,
    lastUsedAt: null,
    revokedAt: null,
  }
  db.insert(apiKeys)
    .values({
      ...info,
      workspaceId: scope.workspaceId,
      hash: sha256(key),
      createdBy: input.createdBy,
    })
    .run()
  return { info, key }
}

/**
 * Finds the active key a caller presented. One of the few lookups without a workspace scope:
 * the key itself is the credential, and it decides the workspace and the server. The lookup is by
 * the SHA-256 of a 256-bit random key, so comparing hashes in the index leaks nothing useful.
 */
export function findActiveApiKey(
  db: Db,
  key: string,
): { id: string; scope: WorkspaceScope; serverId: string } | undefined {
  if (!API_KEY_PATTERN.test(key)) return undefined
  const row = db
    .select({ id: apiKeys.id, workspaceId: apiKeys.workspaceId, serverId: apiKeys.serverId })
    .from(apiKeys)
    .where(and(eq(apiKeys.hash, sha256(key)), isNull(apiKeys.revokedAt)))
    .get()
  return row && { id: row.id, scope: workspaceScope(row.workspaceId), serverId: row.serverId }
}

export function listApiKeys(db: Db, scope: WorkspaceScope, serverId: string): ApiKeyInfo[] {
  return db
    .select(infoColumns)
    .from(apiKeys)
    .where(and(eq(apiKeys.workspaceId, scope.workspaceId), eq(apiKeys.serverId, serverId)))
    .orderBy(apiKeys.createdAt)
    .all()
}

export function revokeApiKey(db: Db, scope: WorkspaceScope, id: string, now = Date.now()): boolean {
  const result = db
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(
      and(
        eq(apiKeys.workspaceId, scope.workspaceId),
        eq(apiKeys.id, id),
        isNull(apiKeys.revokedAt),
      ),
    )
    .run()
  return result.changes === 1
}

/** Records that a key was just used (callers throttle this). */
export function touchApiKey(db: Db, id: string, now = Date.now()): void {
  db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, id)).run()
}
