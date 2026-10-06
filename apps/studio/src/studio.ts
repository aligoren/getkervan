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
import type { Db } from "./db/open.js"
import { type ApiKeyInfo, createApiKey, revokeApiKey } from "./db/repos/api-keys.js"
import { type Actor, recordAudit } from "./db/repos/audit.js"
import {
  createServer,
  deleteServer,
  getServer,
  type Server,
  setPublishedVersion,
} from "./db/repos/servers.js"
import { getVersion, type SpecVersion, saveVersion } from "./db/repos/versions.js"
import type { WorkspaceScope } from "./db/scope.js"
import { exportSpec } from "./export.js"
import { Gateway } from "./gateway.js"
import type { SecretStore } from "./secrets.js"

export interface StudioOptions {
  db: Db
  secrets: SecretStore
  network: NetworkPolicy
  allowedHosts: readonly string[]
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
  readonly code: "not_found" | "invalid"
  readonly issues: SpecIssue[]

  constructor(code: StudioError["code"], message: string, issues: SpecIssue[] = []) {
    super(message)
    this.code = code
    this.issues = issues
  }
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
  readonly secrets: SecretStore
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
      logger: options.logger,
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
    const server = this.db.transaction((tx) => {
      const created = createServer(tx, scope, { slug: input.slug, name })
      recordAudit(tx, scope, actor, {
        action: "server.create",
        target: { type: "server", id: created.id },
        details: { slug: created.slug },
      })
      return created
    })
    return server
  }

  async deleteServer(scope: WorkspaceScope, serverId: string, actor: Actor): Promise<void> {
    const deleted = this.db.transaction((tx) => {
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
      })
      const insecure = this.#options.allowSecretsOverHttp ? [] : secretsOverHttp(loaded.spec)
      if (insecure.length > 0) {
        throw new StudioError("invalid", "The spec is not valid.", insecure)
      }
      return loaded.warnings
    } catch (error) {
      if (error instanceof SpecLoadError) {
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
    await this.validate(scope, serverId, versionId)
    const published = this.db.transaction((tx) => {
      const server = getServer(tx, scope, serverId)
      if (!server) return false
      setPublishedVersion(tx, scope, serverId, versionId)
      recordAudit(tx, scope, actor, {
        action: "server.publish",
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

  /** The version as a kervan.yaml for `kervan run`, with Studio's secret bindings, no values. */
  async exportVersion(scope: WorkspaceScope, serverId: string, versionId: string): Promise<string> {
    const version = getVersion(this.db, scope, serverId, versionId)
    if (!version) throw notFound()
    return exportSpec(version.yamlText, await this.secrets.list(scope, serverId))
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
    const created = this.db.transaction((tx) => {
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
    const revoked = this.db.transaction((tx) => {
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

/**
 * Tools that may send a secret over plain http. A spec author can turn on `allowInsecureHttp`,
 * but a secret an admin entrusted to Studio must only travel encrypted, so Studio refuses them.
 */
function secretsOverHttp(spec: Spec): SpecIssue[] {
  const defaultInsecure = spec.defaults?.http?.allowInsecureHttp === true
  return spec.tools.flatMap((tool, index) => {
    const insecure = tool.http.allowInsecureHttp ?? defaultInsecure
    const usesSecrets = JSON.stringify(tool.http).includes("{{secrets.")
    if (!insecure || !usesSecrets) return []
    return [
      {
        path: ["tools", index, "http", "allowInsecureHttp"],
        message: `Tool "${tool.name}" uses secrets, so it must use https: Studio never sends a secret over plain http.`,
        severity: "error" as const,
      },
    ]
  })
}

function notFound(): StudioError {
  return new StudioError("not_found", "Not found.")
}

function actorUser(actor: Actor): string | null {
  return actor.type === "user" ? (actor.id ?? null) : null
}
