import { and, desc, eq, lt } from "drizzle-orm"
import type { Db } from "../open.js"
import { callLogs } from "../schema.js"
import type { WorkspaceScope } from "../scope.js"

/** Longest logged argument or result text; longer payloads are cut. */
export const MAX_PAYLOAD_CHARS = 4096

export interface CallRecord {
  serverId: string
  versionId: string | null
  tool: string
  status: "ok" | "error"
  durationMs: number
  /** Present only when the server opted in; already redacted and cut. */
  args?: string | undefined
  result?: string | undefined
}

export interface CallLog extends CallRecord {
  id: number
  at: number
}

export function recordCall(db: Db, scope: WorkspaceScope, record: CallRecord, now = Date.now()) {
  db.insert(callLogs)
    .values({
      workspaceId: scope.workspaceId,
      serverId: record.serverId,
      versionId: record.versionId,
      tool: record.tool,
      status: record.status,
      durationMs: Math.round(record.durationMs),
      at: now,
      args: record.args ?? null,
      result: record.result ?? null,
    })
    .run()
}

export function listCalls(db: Db, scope: WorkspaceScope, serverId: string, limit = 100): CallLog[] {
  return db
    .select()
    .from(callLogs)
    .where(and(eq(callLogs.workspaceId, scope.workspaceId), eq(callLogs.serverId, serverId)))
    .orderBy(desc(callLogs.id))
    .limit(Math.min(Math.max(limit, 1), 1000))
    .all()
    .map(({ workspaceId: _workspaceId, args, result, ...row }) => ({
      ...row,
      args: args ?? undefined,
      result: result ?? undefined,
    }))
}

/** Deletes call logs older than `before` (all workspaces: retention is installation-wide). */
export function purgeCalls(db: Db, before: number): number {
  return db.delete(callLogs).where(lt(callLogs.at, before)).run().changes
}

/** Serializes a payload for the log: JSON, cut to `MAX_PAYLOAD_CHARS`. */
export function payloadText(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? "null"
  } catch {
    text = '"[not serializable]"'
  }
  return text.length > MAX_PAYLOAD_CHARS
    ? `${text.slice(0, MAX_PAYLOAD_CHARS)}… [${text.length - MAX_PAYLOAD_CHARS} more characters]`
    : text
}
