import { inspect } from "node:util"
import {
  type App,
  type AuthInfo,
  createApp,
  FORBIDDEN,
  InMemoryToolRegistry,
  type Logger,
  type ResolveResult,
} from "@kervan/core"
import {
  applySpec,
  formatIssue,
  loadSpec,
  type NetworkPolicy,
  SecretVault,
} from "@kervan/spec-runtime"
import { type KervanHttpHandler, toFetchHandler } from "@kervan/transport"
import type { Db } from "./db/open.js"
import { findActiveApiKey } from "./db/repos/api-keys.js"
import { getServer } from "./db/repos/servers.js"
import { getVersion } from "./db/repos/versions.js"
import { type WorkspaceScope, workspaceScope } from "./db/scope.js"
import { FixedWindowLimiter } from "./limiter.js"
import type { SecretStore } from "./secrets.js"

export const GATEWAY_PATH = "/s/:serverId/mcp"
export const GATEWAY_MAX_BODY_BYTES = 1024 * 1024

export interface GatewayOptions {
  db: Db
  secrets: SecretStore
  /** SSRF policy for every tool; Studio builds it with `studioNetworkPolicy`. */
  network: NetworkPolicy
  /** Host names accepted in `Host` and `Origin` headers. */
  allowedHosts: readonly string[]
  logger: Logger
  /** For tests against a local http API only (see `StudioOptions`). */
  allowSecretsOverHttp?: boolean
  /** Requests per API key per minute. Default: 600. */
  keyRateLimit?: number
}

/** One published server: a registry that lives as long as the server, updated in place. */
interface Served {
  scope: WorkspaceScope
  serverId: string
  registry: InMemoryToolRegistry
  signatures: Map<string, string>
  /** Keeps every secret value this server has used, so its results and logs stay redacted. */
  vault: SecretVault
  versionId: string | undefined
  /** Loads run one after another; this is the latest. */
  queue: Promise<void>
}

/**
 * Serves every published server at `/s/{serverId}/mcp`. A request must carry an API key of that
 * server (`Authorization: Bearer kvn_...`); the key decides the workspace and server, the URL only
 * has to agree with it. Each server keeps one registry object for its lifetime, so publishing
 * updates it in place and connected clients get `list_changed`.
 */
export class Gateway {
  readonly app: App
  readonly handler: KervanHttpHandler
  readonly #options: GatewayOptions
  readonly #served = new Map<string, Served>()
  readonly #keyLimiter: FixedWindowLimiter
  /** Open event streams, so revoking a key or deleting a server can end them at once. */
  readonly #streams = new Set<{ keyId: string; serverId: string; abort: AbortController }>()

  constructor(options: GatewayOptions) {
    this.#options = options
    this.#keyLimiter = new FixedWindowLimiter({
      windowMs: 60_000,
      max: options.keyRateLimit ?? 600,
    })
    this.app = createApp({ name: "kervan-studio", version: "0.1.0", logger: options.logger })
    this.handler = toFetchHandler(this.app, {
      path: GATEWAY_PATH,
      allowedHosts: [...options.allowedHosts],
      allowedOrigins: [...options.allowedHosts],
      maxRequestBodySize: GATEWAY_MAX_BODY_BYTES,
      // A batch would run many calls for one request against the per-key limit.
      rejectBatches: true,
      authenticate: (request, { params }) => this.#authenticate(request, params),
      resolveServer: (_request, { auth, params }) => this.resolve(auth, params),
    })
  }

  /** Redacts every secret value any served server has used (for Studio's own logs). */
  redact(text: string): string {
    let result = text
    for (const served of this.#served.values()) result = served.vault.redact(result)
    return result
  }

  /**
   * Re-reads a server's published version and applies it to the server's registry: after a
   * publish, a rollback or a secret change. Clients connected to it get `list_changed` when its
   * tools changed. A server that is gone or unpublished stops being served.
   */
  reload(scope: WorkspaceScope, serverId: string): Promise<void> {
    const served = this.#servedFor(scope, serverId)
    served.queue = served.queue.then(() => this.#load(served))
    return served.queue
  }

  /** Stops serving a deleted server: its tools disappear for clients still connected. */
  remove(scope: WorkspaceScope, serverId: string): void {
    const key = servedKey(scope, serverId)
    const served = this.#served.get(key)
    if (!served) return
    this.#served.delete(key)
    for (const name of served.signatures.keys()) served.registry.remove(name)
    served.signatures.clear()
    served.versionId = undefined
  }

  /** The version a server currently serves (for tests and status pages). */
  servedVersion(scope: WorkspaceScope, serverId: string): string | undefined {
    return this.#served.get(servedKey(scope, serverId))?.versionId
  }

  /**
   * Serves a gateway request. Authentication only runs when a request starts, so an event stream
   * (a `subscriptions/listen` or a long tool call) is tracked under its key and ended when the key
   * is revoked or the server deleted.
   */
  async fetch(request: Request): Promise<Response> {
    const response = await this.handler.fetch(request)
    const isStream = response.headers.get("content-type")?.startsWith("text/event-stream")
    if (!isStream || !response.body) return response
    const key = findActiveApiKey(this.#options.db, bearer(request) ?? "")
    if (!key) {
      // Revoked between authentication and now.
      await response.body.cancel()
      return unauthorized()
    }
    const entry = { keyId: key.id, serverId: key.serverId, abort: new AbortController() }
    this.#streams.add(entry)
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
    response.body
      .pipeTo(writable, { signal: entry.abort.signal })
      .catch(() => {})
      .finally(() => this.#streams.delete(entry))
    return new Response(readable, { status: response.status, headers: response.headers })
  }

  /** How many event streams are open (for status pages and tests). */
  get openStreams(): number {
    return this.#streams.size
  }

  /** Ends the open streams of a key (after it was revoked) or of every key of a server. */
  disconnect(match: { keyId: string } | { serverId: string }): void {
    for (const entry of this.#streams) {
      const hit = "keyId" in match ? entry.keyId === match.keyId : entry.serverId === match.serverId
      if (hit) {
        this.#streams.delete(entry)
        entry.abort.abort()
      }
    }
  }

  close(): Promise<void> {
    for (const entry of this.#streams) entry.abort.abort()
    this.#streams.clear()
    return this.handler.close()
  }

  #authenticate(request: Request, params: Readonly<Record<string, string>>): AuthInfo | Response {
    const presented = bearer(request)
    const key = presented ? findActiveApiKey(this.#options.db, presented) : undefined
    // One answer for a missing key, an unknown or revoked key, and another server's key: callers
    // learn nothing about which servers exist.
    if (!key || key.serverId !== params.serverId) return unauthorized()
    const wait = this.#keyLimiter.hit(key.id)
    if (wait > 0) {
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Too many requests" }, id: null },
        { status: 429, headers: { "retry-after": String(wait) } },
      )
    }
    return {
      // The key itself never travels further than this function.
      token: key.id,
      clientId: key.id,
      scopes: [],
      extra: { workspaceId: key.scope.workspaceId, serverId: key.serverId },
    }
  }

  /**
   * Picks the registry for an authenticated request. Checks again that the key's server is the
   * one in the URL (authentication already did), so a mistake in one layer is not enough.
   */
  async resolve(
    auth: AuthInfo | undefined,
    params: Readonly<Record<string, string>>,
  ): Promise<ResolveResult> {
    const workspaceId = auth?.extra?.workspaceId
    const serverId = auth?.extra?.serverId
    if (typeof workspaceId !== "string" || typeof serverId !== "string") return FORBIDDEN
    if (serverId !== params.serverId) return FORBIDDEN
    const scope = workspaceScope(workspaceId)
    const key = servedKey(scope, serverId)
    if (!this.#served.has(key)) await this.reload(scope, serverId)
    else await this.#served.get(key)?.queue
    const served = this.#served.get(key)
    return served?.versionId === undefined ? null : served.registry
  }

  #servedFor(scope: WorkspaceScope, serverId: string): Served {
    const key = servedKey(scope, serverId)
    let served = this.#served.get(key)
    if (!served) {
      served = {
        scope,
        serverId,
        registry: new InMemoryToolRegistry({
          onListenerError: (error) => this.#options.logger.error("Registry listener failed", error),
        }),
        signatures: new Map(),
        vault: new SecretVault(),
        versionId: undefined,
        queue: Promise.resolve(),
      }
      this.#served.set(key, served)
    }
    return served
  }

  async #load(served: Served): Promise<void> {
    const { db, logger } = this.#options
    const server = getServer(db, served.scope, served.serverId)
    const version =
      server?.publishedVersionId &&
      getVersion(db, served.scope, served.serverId, server.publishedVersionId)
    if (!server || !version) {
      this.remove(served.scope, served.serverId)
      return
    }
    const fileName = `${server.slug}/v${version.number}`
    try {
      const loaded = await loadSpec(version.yamlText, {
        fileName,
        secrets: this.#options.secrets.source(served.scope, served.serverId),
        vault: served.vault,
        network: this.#options.network,
        allowSecretsOverHttp: this.#options.allowSecretsOverHttp === true,
      })
      served.registry.serverInfo = {
        name: loaded.spec.name,
        version: loaded.spec.version,
        ...(loaded.spec.description === undefined ? {} : { instructions: loaded.spec.description }),
      }
      served.signatures = applySpec(served.registry, loaded, served.signatures)
      served.versionId = version.id
      for (const warning of loaded.warnings) {
        logger.warn(served.vault.redact(`Server ${server.slug}: ${formatIssue(fileName, warning)}`))
      }
    } catch (error) {
      // Publishing validates first, so this is rare (e.g. a secret changed). Keep serving the
      // last good version, if any.
      logger.error(
        served.vault.redact(
          `Could not load ${fileName}; ${served.versionId ? "still serving the previous version" : "not serving it"}: ${inspect(error)}`,
        ),
      )
    }
  }
}

function servedKey(scope: WorkspaceScope, serverId: string): string {
  return `${scope.workspaceId}/${serverId}`
}

function bearer(request: Request): string | undefined {
  return /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1]
}

function unauthorized(): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null },
    { status: 401, headers: { "www-authenticate": 'Bearer realm="kervan-studio"' } },
  )
}
