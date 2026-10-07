import { and, desc, eq, inArray, max } from "drizzle-orm"
import type { Db } from "../open.js"
import { callLogs, servers, specVersions, versionChecks } from "../schema.js"
import type { WorkspaceScope } from "../scope.js"

export interface VersionCheck {
  valid: boolean
  problems: number
  secrets: number
  checkedAt: number
}

/** Records the latest validation of a version (on save, validate and publish). */
export function recordCheck(
  db: Db,
  scope: WorkspaceScope,
  versionId: string,
  check: Omit<VersionCheck, "checkedAt">,
  now = Date.now(),
): void {
  const row = { ...check, checkedAt: now }
  db.insert(versionChecks)
    .values({ versionId, workspaceId: scope.workspaceId, ...row })
    .onConflictDoUpdate({ target: versionChecks.versionId, set: row })
    .run()
}

/** The latest checks of some versions, by version id (versions never checked are absent). */
export function checksOf(
  db: Db,
  scope: WorkspaceScope,
  versionIds: readonly string[],
): Map<string, VersionCheck> {
  if (versionIds.length === 0) return new Map()
  const rows = db
    .select()
    .from(versionChecks)
    .where(
      and(
        eq(versionChecks.workspaceId, scope.workspaceId),
        inArray(versionChecks.versionId, [...versionIds]),
      ),
    )
    .all()
  return new Map(
    rows.map((row) => [
      row.versionId,
      { valid: row.valid, problems: row.problems, secrets: row.secrets, checkedAt: row.checkedAt },
    ]),
  )
}

export interface ServerSummary {
  /** The newest version, with its latest check (`null` when it was never checked). */
  latest: { id: string; number: number; check: VersionCheck | null } | null
  /** The published version's number. */
  publishedNumber: number | null
  lastCallAt: number | null
}

/** What the server list shows next to each server: status of its versions and its last call. */
export function serverSummaries(db: Db, scope: WorkspaceScope): Map<string, ServerSummary> {
  const all = db
    .select({ id: servers.id, publishedVersionId: servers.publishedVersionId })
    .from(servers)
    .where(eq(servers.workspaceId, scope.workspaceId))
    .all()
  const summaries = new Map<string, ServerSummary>()
  for (const server of all) {
    const latest = db
      .select({ id: specVersions.id, number: specVersions.number })
      .from(specVersions)
      .where(
        and(eq(specVersions.workspaceId, scope.workspaceId), eq(specVersions.serverId, server.id)),
      )
      .orderBy(desc(specVersions.number))
      .limit(1)
      .get()
    const published = server.publishedVersionId
      ? db
          .select({ number: specVersions.number })
          .from(specVersions)
          .where(
            and(
              eq(specVersions.workspaceId, scope.workspaceId),
              eq(specVersions.id, server.publishedVersionId),
            ),
          )
          .get()
      : undefined
    const lastCall = db
      .select({ at: max(callLogs.at) })
      .from(callLogs)
      .where(and(eq(callLogs.workspaceId, scope.workspaceId), eq(callLogs.serverId, server.id)))
      .get()
    summaries.set(server.id, {
      latest: latest
        ? { ...latest, check: checksOf(db, scope, [latest.id]).get(latest.id) ?? null }
        : null,
      publishedNumber: published?.number ?? null,
      lastCallAt: lastCall?.at ?? null,
    })
  }
  return summaries
}
