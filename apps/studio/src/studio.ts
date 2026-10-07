import type { Logger } from "@kervan/core"
import {
  loadSpec,
  type NetworkPolicy,
  SecretVault,
  SPEC_LIMITS,
  type Spec,
  type SpecIssue,
  SpecLoadError,
} from "@kervan/spec-runtime"
import { type Db, writeTransaction } from "./db/open.js"
import { type ApiKeyInfo, createApiKey, revokeApiKey } from "./db/repos/api-keys.js"
import { type Actor, recordAudit } from "./db/repos/audit.js"
import { listCalls } from "./db/repos/call-logs.js"
import {
  createServer,
  deleteServer,
  getServer,
  type Server,
  setLogPayloads,
  setPublishedVersion,
} from "./db/repos/servers.js"
import { recordCheck } from "./db/repos/version-checks.js"
import { getVersion, type SpecVersion, saveVersion } from "./db/repos/versions.js"
import type { WorkspaceScope } from "./db/scope.js"
import { diffLines } from "./diff.js"
import { unsafeTextProblem } from "./display-text.js"
import { exportSpec } from "./export.js"
import { Gateway } from "./gateway.js"
import { PlaygroundTokens } from "./playground.js"
import {
  checkSecretName,
  type SecretBinding,
  type SecretWrite,
  type WritableSecretStore,
} from "./secrets.js"

export interface StudioOptions {
  db: Db
  secrets: WritableSecretStore
  network: NetworkPolicy
  allowedHosts: readonly string[]
  /** Exact origins accepted in the gateway's `Origin` header (see `GatewayOptions`). */
  allowedOrigins: readonly string[]
  logger: Logger
  keyRateLimit?: number
  /**
   * Let tools send secrets over plain http. For tests against a local http API only; Studio
   * itself (`startStudio`) never sets it.
   */
  allowSecretsOverHttp?: boolean
}

/** A request the caller can fix: shown to the user as is (it never contains secret values). */
export class StudioError extends Error {
  override name = "StudioError"
  readonly code: "not_found" | "invalid" | "conflict" | "forbidden"
  readonly issues: SpecIssue[]
  /** Extra, non-secret fields for the API response (e.g. which tools use a secret). */
  readonly details: Record<string, unknown>

  constructor(
    code: StudioError["code"],
    message: string,
    issues: SpecIssue[] = [],
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.code = code
    this.issues = issues
    this.details = details
  }
}

export interface SecretUsage {
  version: number
  versionId: string
  tools: string[]
}

const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
const MAX_NAME_LENGTH = 200

/**
 * Studio's operations, independent of HTTP: the management API (and the CLI) call these, and
 * every one takes the workspace scope of a verified caller.
 */
export class Studio {
  readonly db: Db
  readonly gateway: Gateway
  readonly secrets: WritableSecretStore
  readonly playground = new PlaygroundTokens()
  readonly #options: StudioOptions

  constructor(options: StudioOptions) {
    this.#options = options
    this.db = options.db
    this.secrets = options.secrets
    this.gateway = new Gateway({
      db: options.db,
      secrets: options.secrets,
      network: options.network,
      allowedHosts: options.allowedHosts,
      allowedOrigins: options.allowedOrigins,
      logger: options.logger,
      allowSecretsOverHttp: options.allowSecretsOverHttp === true,
      playground: this.playground,
      ...(options.keyRateLimit === undefined ? {} : { keyRateLimit: options.keyRateLimit }),
    })
  }

  createServer(scope: WorkspaceScope, input: { slug: string; name: string }, actor: Actor): Server {
    if (!SLUG.test(input.slug)) {
      throw new StudioError(
        "invalid",
        "The slug must be 1-64 of a-z, 0-9 and -, starting and ending with a letter or digit.",
      )
    }
    const name = input.name.trim()
    if (name === "" || name.length > MAX_NAME_LENGTH) {
      throw new StudioError("invalid", `The name must be 1-${MAX_NAME_LENGTH} characters.`)
    }
    const unsafe = unsafeTextProblem(name, "The name")
    if (unsafe) throw new StudioError("invalid", unsafe)
    try {
      return writeTransaction(this.db, (tx) => {
        const created = createServer(tx, scope, { slug: input.slug, name })
        recordAudit(tx, scope, actor, {
          action: "server.create",
          target: { type: "server", id: created.id },
          details: { slug: created.slug },
        })
        return created
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new StudioError("conflict", "A server with this slug already exists.")
      }
      throw error
    }
  }

  async deleteServer(scope: WorkspaceScope, serverId: string, actor: Actor): Promise<void> {
    const deleted = writeTransaction(this.db, (tx) => {
      if (!deleteServer(tx, scope, serverId)) return false
      recordAudit(tx, scope, actor, {
        action: "server.delete",
        target: { type: "server", id: serverId },
      })
      return true
    })
    if (!deleted) throw notFound()
    this.gateway.remove(scope, serverId)
    this.gateway.disconnect({ serverId })
  }

  /** Saves a new draft version. Drafts may be invalid; publishing validates. */
  saveVersion(
    scope: WorkspaceScope,
    serverId: string,
    yamlText: string,
    actor: Actor,
  ): SpecVersion {
    if (Buffer.byteLength(yamlText) > SPEC_LIMITS.maxSpecBytes) {
      throw new StudioError("invalid", `A spec can be at most ${SPEC_LIMITS.maxSpecBytes} bytes.`)
    }
    const version = saveVersion(this.db, scope, serverId, yamlText, actorUser(actor))
    if (!version) throw notFound()
    return version
  }

  /**
   * Validates a version the way publishing does: the spec must load, and every secret a tool uses
   * must be available, from this server's secrets, for the host that tool calls.
   */
  async validate(scope: WorkspaceScope, serverId: string, versionId: string): Promise<SpecIssue[]> {
    const version = getVersion(this.db, scope, serverId, versionId)
    if (!version) throw notFound()
    try {
      const loaded = await loadSpec(version.yamlText, {
        fileName: "kervan.yaml",
        secrets: this.secrets.source(scope, serverId),
        // A throwaway vault: validation must not change what the running server redacts.
        vault: new SecretVault(),
        network: this.#options.network,
        requireSecrets: true,
        allowSecretsOverHttp: this.#options.allowSecretsOverHttp === true,
      })
      // Remembered for the server list and the version history ("valid", "has problems").
      recordCheck(this.db, scope, versionId, {
        valid: true,
        problems: 0,
        secrets: loaded.spec.secrets?.length ?? 0,
      })
      return loaded.warnings
    } catch (error) {
      if (error instanceof SpecLoadError) {
        recordCheck(this.db, scope, versionId, {
          valid: false,
          problems: error.issues.length,
          secrets: 0,
        })
        throw new StudioError("invalid", "The spec is not valid.", error.issues)
      }
      throw error
    }
  }

  /**
   * Publishes a version (also used to roll back to an older one): validates it, points the server
   * at it, records it in the audit log, and updates the gateway's registry in place.
   */
  async publish(
    scope: WorkspaceScope,
    serverId: string,
    versionId: string,
    actor: Actor,
  ): Promise<SpecVersion> {
    const version = getVersion(this.db, scope, serverId, versionId)
    if (!version) throw notFound()
    try {
      await this.validate(scope, serverId, versionId)
    } catch (error) {
      if (!(error instanceof StudioError) || error.code !== "invalid") throw error
      // A refused publish can be an attempt to send a secret somewhere else: keep a record.
      recordAudit(this.db, scope, actor, {
        action: "server.publish_refused",
        target: { type: "server", id: serverId },
        details: { version: version.number, versionId, problems: error.issues.length },
      })
      throw new StudioError("invalid", "Not published: fix the problems below.", error.issues)
    }
    const published = writeTransaction(this.db, (tx) => {
      const server = getServer(tx, scope, serverId)
      if (!server) return false
      const current =
        server.publishedVersionId && getVersion(tx, scope, serverId, server.publishedVersionId)
      // Publishing an older version than the one being served is a rollback.
      const rollback = Boolean(current && current.number > version.number)
      setPublishedVersion(tx, scope, serverId, versionId)
      recordAudit(tx, scope, actor, {
        action: rollback ? "server.rollback" : "server.publish",
        target: { type: "server", id: serverId },
        details: {
          version: version.number,
          versionId,
          previousVersionId: server.publishedVersionId,
        },
      })
      return true
    })
    if (!published) throw notFound()
    await this.gateway.reload(scope, serverId)
    return version
  }

  /** A line diff between two versions of a server; `undefined` when too large to compute. */
  diffVersions(scope: WorkspaceScope, serverId: string, fromId: string, toId: string) {
    const from = getVersion(this.db, scope, serverId, fromId)
    const to = getVersion(this.db, scope, serverId, toId)
    if (!from || !to) throw notFound()
    return {
      from: from.number,
      to: to.number,
      lines: diffLines(from.yamlText, to.yamlText),
    }
  }

  /** Turns logging of (redacted, cut) call arguments and results on or off for a server. */
  setLogPayloads(scope: WorkspaceScope, serverId: string, on: boolean, actor: Actor): void {
    const changed = writeTransaction(this.db, (tx) => {
      if (!setLogPayloads(tx, scope, serverId, on)) return false
      recordAudit(tx, scope, actor, {
        action: "server.settings",
        target: { type: "server", id: serverId },
        details: { logPayloads: on },
      })
      return true
    })
    if (!changed) throw notFound()
  }

  /**
   * A server's recent calls. Arguments and results (when the server logs them) are for admins
   * only; members see the metadata.
   */
  listCalls(scope: WorkspaceScope, serverId: string, options: { withPayloads: boolean }) {
    if (!getServer(this.db, scope, serverId)) throw notFound()
    return listCalls(this.db, scope, serverId).map((call) =>
      options.withPayloads ? call : { ...call, args: undefined, result: undefined },
    )
  }

  /** The version as a kervan.yaml for `kervan run`, with Studio's secret bindings, no values. */
  async exportVersion(scope: WorkspaceScope, serverId: string, versionId: string): Promise<string> {
    const version = getVersion(this.db, scope, serverId, versionId)
    if (!version) throw notFound()
    return exportSpec(version.yamlText, await this.secrets.list(scope, serverId))
  }

  /**
   * Issues a playground token for one version of a server (drafts included): the signed-in user's
   * browser calls the gateway with it for 15 minutes.
   */
  playgroundToken(
    scope: WorkspaceScope,
    serverId: string,
    versionId: string,
    session: { userId: string; sessionHash: string },
  ): { token: string; expiresAt: number } {
    if (!getVersion(this.db, scope, serverId, versionId)) throw notFound()
    return this.playground.issue({
      workspaceId: scope.workspaceId,
      serverId,
      versionId,
      ...session,
    })
  }

  /** A server's secrets: names, bindings and which published tools use them. Never values. */
  async listSecrets(
    scope: WorkspaceScope,
    serverId: string,
  ): Promise<(SecretBinding & { usedBy: SecretUsage | null })[]> {
    if (!getServer(this.db, scope, serverId)) throw notFound()
    const bindings = await this.secrets.list(scope, serverId)
    return Promise.all(
      bindings.map(async (binding) => ({
        ...binding,
        usedBy: await this.secretUsage(scope, serverId, binding.name),
      })),
    )
  }

  /**
   * Creates a secret, rotates its value or changes its hosts. A changed value is used from the
   * next call on; the old value stays redacted wherever the server already saw it.
   */
  async putSecret(
    scope: WorkspaceScope,
    serverId: string,
    input: SecretWrite,
    actor: Actor,
  ): Promise<SecretBinding> {
    if (!getServer(this.db, scope, serverId)) throw notFound()
    const result = await this.secrets.put(scope, serverId, input)
    const action = result.created
      ? "secret.create"
      : result.rotated
        ? "secret.rotate"
        : "secret.hosts"
    recordAudit(this.db, scope, actor, {
      action,
      target: { type: "server", id: serverId },
      details: { name: input.name, hosts: result.binding.allowedHosts.join(",") },
    })
    return result.binding
  }

  /**
   * Deletes a secret. When the published version uses it, this refuses (with the tools that use
   * it) unless `confirm` is set; after deletion those tools fail with "Secret X is not configured".
   */
  async deleteSecret(
    scope: WorkspaceScope,
    serverId: string,
    name: string,
    options: { confirm: boolean },
    actor: Actor,
  ): Promise<void> {
    if (!getServer(this.db, scope, serverId)) throw notFound()
    checkSecretName(name)
    const usedBy = await this.secretUsage(scope, serverId, name)
    if (usedBy && !options.confirm) {
      throw new StudioError(
        "conflict",
        `Secret ${name} is used by the published version ${usedBy.version} (${usedBy.tools.join(", ")}). ` +
          "Those tools will fail until the secret exists again. Confirm to delete it anyway.",
        [],
        { usedBy },
      )
    }
    if (!(await this.secrets.remove(scope, serverId, name))) throw notFound()
    recordAudit(this.db, scope, actor, {
      action: "secret.delete",
      target: { type: "server", id: serverId },
      details: { name, usedByTools: usedBy ? usedBy.tools.join(",") : null },
    })
  }

  /** Which tools of the published version use a secret (conservatively, by their templates). */
  async secretUsage(
    scope: WorkspaceScope,
    serverId: string,
    name: string,
  ): Promise<SecretUsage | null> {
    // The name goes into a pattern below: only valid secret names get that far.
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) return null
    const server = getServer(this.db, scope, serverId)
    const version =
      server?.publishedVersionId && getVersion(this.db, scope, serverId, server.publishedVersionId)
    if (!version) return null
    let spec: Spec
    try {
      spec = (
        await loadSpec(version.yamlText, {
          secrets: { get: () => undefined },
          vault: new SecretVault(),
          network: this.#options.network,
          allowSecretsOverHttp: true,
        })
      ).spec
    } catch {
      return null
    }
    const reference = new RegExp(`\\{\\{\\s*secrets\\.${name}\\s*\\}\\}`)
    const tools = spec.tools
      .filter((tool) => reference.test(JSON.stringify(tool.http)))
      .map((tool) => tool.name)
    return tools.length > 0 ? { version: version.number, versionId: version.id, tools } : null
  }

  /** Creates an API key for a server. The key is returned once and never stored. */
  createApiKey(
    scope: WorkspaceScope,
    serverId: string,
    name: string,
    actor: Actor,
  ): { info: ApiKeyInfo; key: string } {
    const trimmed = name.trim()
    if (trimmed === "" || trimmed.length > MAX_NAME_LENGTH) {
      throw new StudioError("invalid", `The key name must be 1-${MAX_NAME_LENGTH} characters.`)
    }
    const unsafe = unsafeTextProblem(trimmed, "The key name")
    if (unsafe) throw new StudioError("invalid", unsafe)
    const created = writeTransaction(this.db, (tx) => {
      const result = createApiKey(tx, scope, {
        serverId,
        name: trimmed,
        createdBy: actorUser(actor),
      })
      if (result) {
        recordAudit(tx, scope, actor, {
          action: "api_key.create",
          target: { type: "api_key", id: result.info.id },
          details: { serverId, prefix: result.info.prefix },
        })
      }
      return result
    })
    if (!created) throw notFound()
    return created
  }

  revokeApiKey(scope: WorkspaceScope, keyId: string, actor: Actor): void {
    const revoked = writeTransaction(this.db, (tx) => {
      if (!revokeApiKey(tx, scope, keyId)) return false
      recordAudit(tx, scope, actor, {
        action: "api_key.revoke",
        target: { type: "api_key", id: keyId },
      })
      return true
    })
    if (!revoked) throw notFound()
    this.gateway.disconnect({ keyId })
  }

  close(): Promise<void> {
    return this.gateway.close()
  }
}

/** Whether SQLite refused a write because of a UNIQUE constraint. */
export function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: unknown; cause?: { code?: unknown } } | null)?.code
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause?.code
  return code === "SQLITE_CONSTRAINT_UNIQUE" || cause === "SQLITE_CONSTRAINT_UNIQUE"
}

function notFound(): StudioError {
  return new StudioError("not_found", "Not found.")
}

function actorUser(actor: Actor): string | null {
  return actor.type === "user" ? (actor.id ?? null) : null
}
