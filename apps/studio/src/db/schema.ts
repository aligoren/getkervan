import { blob, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"

// Every table that holds workspace data has a workspace_id, and every query on it filters by one
// (see scope.ts). Times are Unix milliseconds. Ids are random UUIDs.

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: integer("created_at").notNull(),
})

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    email: text("email").notNull(),
    /** `scrypt$N$r$p$salt$hash`; see crypto.ts. */
    passwordHash: text("password_hash").notNull(),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** Set while the user is deactivated: no sign-in, no sessions, no playground tokens. */
    disabledAt: integer("disabled_at"),
  },
  (t) => [uniqueIndex("users_workspace_email").on(t.workspaceId, t.email)],
)

export const sessions = sqliteTable(
  "sessions",
  {
    /** SHA-256 of the session id; the id itself lives only in the browser's cookie. */
    idHash: text("id_hash").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("sessions_user").on(t.userId)],
)

export const servers = sqliteTable(
  "servers",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    /** The version the gateway serves; null until the first publish. */
    publishedVersionId: text("published_version_id"),
    /** Opt-in: also log (redacted, truncated) arguments and results of tool calls. */
    logPayloads: integer("log_payloads", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("servers_workspace_slug").on(t.workspaceId, t.slug)],
)

/** Immutable: a trigger refuses updates (see the custom migration). */
export const specVersions = sqliteTable(
  "spec_versions",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    yamlText: text("yaml_text").notNull(),
    sha256: text("sha256").notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("spec_versions_server_number").on(t.serverId, t.number)],
)

/** Encrypted at rest (AES-256-GCM); values are never read back through any API. */
export const secrets = sqliteTable(
  "secrets",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** JSON array of normalized host names; never empty. */
    allowedHosts: text("allowed_hosts").notNull(),
    ciphertext: blob("ciphertext", { mode: "buffer" }).notNull(),
    iv: blob("iv", { mode: "buffer" }).notNull(),
    tag: blob("tag", { mode: "buffer" }).notNull(),
    keyVersion: integer("key_version").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [uniqueIndex("secrets_server_name").on(t.serverId, t.name)],
)

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** The first characters of the key, shown so people can tell keys apart. */
    prefix: text("prefix").notNull(),
    /** SHA-256 of the whole key; the key itself is shown once and never stored. */
    hash: text("hash").notNull(),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    lastUsedAt: integer("last_used_at"),
    revokedAt: integer("revoked_at"),
  },
  (t) => [uniqueIndex("api_keys_hash").on(t.hash), index("api_keys_server").on(t.serverId)],
)

/** Append-only: triggers refuse updates and deletes (see the custom migration). */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    at: integer("at").notNull(),
    actorType: text("actor_type", { enum: ["user", "api_key", "system", "cli"] }).notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    /** JSON object of non-secret details. */
    details: text("details"),
  },
  (t) => [index("audit_events_workspace_at").on(t.workspaceId, t.at)],
)

export const callLogs = sqliteTable(
  "call_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    serverId: text("server_id")
      .notNull()
      .references(() => servers.id, { onDelete: "cascade" }),
    versionId: text("version_id"),
    tool: text("tool").notNull(),
    status: text("status", { enum: ["ok", "error"] }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    at: integer("at").notNull(),
    /** Only when the server opts in; redacted and size-limited. */
    args: text("args"),
    result: text("result"),
  },
  (t) => [index("call_logs_server_at").on(t.serverId, t.at)],
)

/** Single-use tokens (first-run setup). Only the hash is stored. */
export const oneTimeTokens = sqliteTable("one_time_tokens", {
  hash: text("hash").primaryKey(),
  purpose: text("purpose", { enum: ["setup"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
})
