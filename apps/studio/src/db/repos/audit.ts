import { and, desc, eq } from "drizzle-orm"
import type { Db } from "../open.js"
import { auditEvents } from "../schema.js"
import type { WorkspaceScope } from "../scope.js"

export interface Actor {
  type: "user" | "api_key" | "system" | "cli"
  id?: string | undefined
  ip?: string | undefined
  /**
   * What the API checked when the request came in: an active user, or an admin. Writes check it
   * again in their transaction (`requireActor`); it is not recorded.
   */
  requires?: "admin" | "user" | undefined
}

export interface AuditInput {
  action: string
  target?: { type: string; id: string }
  /** Non-secret details only: names, ids, counts. Never values, keys or passwords. */
  details?: Record<string, string | number | boolean | null>
}

export interface AuditEvent {
  id: number
  at: number
  actorType: Actor["type"]
  actorId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  ip: string | null
  details: Record<string, unknown> | null
}

export function recordAudit(
  db: Db,
  scope: WorkspaceScope,
  actor: Actor,
  input: AuditInput,
  now = Date.now(),
): void {
  db.insert(auditEvents)
    .values({
      workspaceId: scope.workspaceId,
      at: now,
      actorType: actor.type,
      actorId: actor.id ?? null,
      action: input.action,
      targetType: input.target?.type ?? null,
      targetId: input.target?.id ?? null,
      ip: actor.ip ?? null,
      details: input.details ? JSON.stringify(input.details) : null,
    })
    .run()
}

export function listAudit(
  db: Db,
  scope: WorkspaceScope,
  options: { action?: string; limit?: number } = {},
): AuditEvent[] {
  const rows = db
    .select()
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.workspaceId, scope.workspaceId),
        options.action === undefined ? undefined : eq(auditEvents.action, options.action),
      ),
    )
    .orderBy(desc(auditEvents.id))
    .limit(Math.min(options.limit ?? 100, 1000))
    .all()
  return rows.map(({ workspaceId: _workspaceId, details, ...row }) => ({
    ...row,
    details: details === null ? null : (JSON.parse(details) as Record<string, unknown>),
  }))
}
