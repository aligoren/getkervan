import { inspect } from "node:util"
import {
  type App,
  type AuthInfo,
  type CallToolResult,
  createApp,
  FORBIDDEN,
  InMemoryToolRegistry,
  type Logger,
  type ResolveResult,
  type ToolCall,
  ToolError,
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
import { findActiveApiKey, touchApiKey } from "./db/repos/api-keys.js"
import { payloadText, recordCall } from "./db/repos/call-logs.js"
import { getServer } from "./db/repos/servers.js"
import { getVersion } from "./db/repos/versions.js"
import { type WorkspaceScope, workspaceScope } from "./db/scope.js"
import { FixedWindowLimiter } from "./limiter.js"
import type { PlaygroundTokens } from "./playground.js"
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
  /** Verifies playground tokens (`kvp_...`); without it only API keys are accepted. */
  playground?: PlaygroundTokens
}

/** How long an unused playground draft stays loaded. */
export const DRAFT_TTL_MS = 15 * 60 * 1000

/** A version loaded for the playground, which may not be published. */
interface Draft {
  registry: InMemoryToolRegistry
  vault: SecretVault
  serverId: string
  /** Resolves to whether the version loaded. */
  ready: Promise<boolean>
  lastUsed: number
}

/** Who is calling: an API key, or a signed-in user's playground token. */
interface Caller {
  /** Key id, or `playground:<user>` (stream tracking and rate limits). */
  id: string
  scope: WorkspaceScope
  serverId: string
  /** Set for playground tokens: the version (published or draft) they may call. */
  versionId?: string
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
  readonly #drafts = new Map<string, Draft>()
  readonly #lastTouched = new Map<string, number>()
  readonly #sweeper: NodeJS.Timeout

  constructor(options: GatewayOptions) {
    this.#options = options
    this.#keyLimiter = new FixedWindowLimiter({
      windowMs: 60_000,
      max: options.keyRateLimit ?? 600,
    })
    this.app = createApp({ name: "kervan-studio", version: "0.1.0", logger: options.logger })
    this.app.use((call, next) => this.#logCall(call, next))
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
    this.#sweeper = setInterval(() => this.sweepDrafts(), 60_000)
    this.#sweeper.unref()
  }

  /** Redacts every secret value any served server has used (for Studio's own logs). */
  redact(text: string): string {
    let result = text
    for (const served of this.#served.values()) result = served.vault.redact(result)
    for (const draft of this.#drafts.values()) result = draft.vault.redact(result)
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
    const caller = this.#caller(request)
    if (!caller) {
      // Revoked (or expired) between authentication and now.
      await response.body.cancel()
      return unauthorized()
    }
    const entry = { keyId: caller.id, serverId: caller.serverId, abort: new AbortController() }
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
    if ("serverId" in match) {
      for (const [key, draft] of this.#drafts) {
        if (draft.serverId === match.serverId) this.#drafts.delete(key)
      }
    }
  }

  /** How many playground drafts are loaded (for tests and status pages). */
  get loadedDrafts(): number {
    return this.#drafts.size
  }

  /** Unloads playground drafts nobody used for `DRAFT_TTL_MS`. Runs every minute. */
  sweepDrafts(now = Date.now()): void {
    for (const [versionId, draft] of this.#drafts) {
      if (now - draft.lastUsed >= DRAFT_TTL_MS) this.#drafts.delete(versionId)
    }
  }

  close(): Promise<void> {
    clearInterval(this.#sweeper)
    for (const entry of this.#streams) entry.abort.abort()
    this.#streams.clear()
    this.#drafts.clear()
    return this.handler.close()
  }

  /** Writes an API key's `last_used_at`, at most once a minute per key. */
  #touch(keyId: string, now = Date.now()): void {
    if (now - (this.#lastTouched.get(keyId) ?? 0) < 60_000) return
    this.#lastTouched.set(keyId, now)
    try {
      touchApiKey(this.#options.db, keyId, now)
    } catch (error) {
      this.#options.logger.warn("Could not record API key use", error)
    }
  }

  /**
   * Records every tool call: tool, status, duration and version. Arguments and results only when
   * the server opted in, redacted with the server's vault and cut to a few KiB.
   */
  async #logCall(call: ToolCall, next: () => Promise<CallToolResult>): Promise<CallToolResult> {
    const started = performance.now()
    let result: CallToolResult | undefined
    let failure: unknown
    try {
      result = await next()
      return result
    } catch (error) {
      failure = error
      throw error
    } finally {
      try {
        this.#recordCall(call, performance.now() - started, result, failure)
      } catch (error) {
        this.#options.logger.warn("Could not record a tool call", error)
      }
    }
  }

  #recordCall(
    call: ToolCall,
    durationMs: number,
    result: CallToolResult | undefined,
    failure: unknown,
  ): void {
    const extra = call.ctx.auth?.extra
    const workspaceId = extra?.workspaceId
    const serverId = extra?.serverId
    if (typeof workspaceId !== "string" || typeof serverId !== "string") return
    const scope = workspaceScope(workspaceId)
    const draftVersion = typeof extra?.versionId === "string" ? extra.versionId : undefined
    const served = this.#served.get(servedKey(scope, serverId))
    const versionId = draftVersion ?? served?.versionId ?? null
    const vault = draftVersion
      ? this.#drafts.get(`${workspaceId}/${serverId}/${draftVersion}`)?.vault
      : served?.vault
    const status = failure !== undefined || result?.isError ? "error" : "ok"
    const server = getServer(this.#options.db, scope, serverId)
    let payloads: { args?: string; result?: string } = {}
    if (server?.logPayloads && vault) {
      const outcome =
        failure === undefined
          ? result
          : failure instanceof ToolError
            ? { error: failure.message }
            : { error: "internal error" }
      payloads = {
        args: payloadText(vault.redactValue(call.input)),
        result: payloadText(vault.redactValue(outcome)),
      }
    }
    recordCall(this.#options.db, scope, {
      serverId,
      versionId,
      tool: call.tool.name,
      status,
      durationMs,
      ...payloads,
    })
  }

  /** The verified caller of a request, from its API key or playground token. */
  #caller(request: Request): Caller | undefined {
    const presented = bearer(request)
    if (!presented) return undefined
    if (presented.startsWith("kvp_")) {
      const grant = this.#options.playground?.verify(presented)
      if (!grant) return undefined
      return {
        id: `playground:${grant.userId}`,
        scope: workspaceScope(grant.workspaceId),
        serverId: grant.serverId,
        versionId: grant.versionId,
      }
    }
    const key = findActiveApiKey(this.#options.db, presented)
    return key && { id: key.id, scope: key.scope, serverId: key.serverId }
  }

  #authenticate(request: Request, params: Readonly<Record<string, string>>): AuthInfo | Response {
    const key = this.#caller(request)
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
    if (key.versionId === undefined) this.#touch(key.id)
    return {
      // The key itself never travels further than this function.
      token: key.id,
      clientId: key.id,
      scopes: [],
      extra: {
        workspaceId: key.scope.workspaceId,
        serverId: key.serverId,
        ...(key.versionId === undefined ? {} : { versionId: key.versionId }),
      },
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
    const versionId = auth?.extra?.versionId
    if (typeof versionId === "string") return this.#draft(scope, serverId, versionId)
    const key = servedKey(scope, serverId)
    if (!this.#served.has(key)) await this.reload(scope, serverId)
    else await this.#served.get(key)?.queue
    const served = this.#served.get(key)
    return served?.versionId === undefined ? null : served.registry
  }

  /**
   * The registry of one version for the playground. It is loaded like a published version (the
   * same secret source, bindings and network policy) and dropped after `DRAFT_TTL_MS` unused.
   */
  async #draft(scope: WorkspaceScope, serverId: string, versionId: string): Promise<ResolveResult> {
    const key = `${scope.workspaceId}/${serverId}/${versionId}`
    let draft = this.#drafts.get(key)
    if (!draft) {
      const registry = new InMemoryToolRegistry({
        onListenerError: (error) => this.#options.logger.error("Registry listener failed", error),
      })
      const vault = new SecretVault()
      draft = {
        registry,
        vault,
        serverId,
        lastUsed: Date.now(),
        ready: this.#loadDraft(scope, serverId, versionId, registry, vault),
      }
      this.#drafts.set(key, draft)
    }
    draft.lastUsed = Date.now()
    if (!(await draft.ready)) {
      this.#drafts.delete(key)
      return null
    }
    return draft.registry
  }

  async #loadDraft(
    scope: WorkspaceScope,
    serverId: string,
    versionId: string,
    registry: InMemoryToolRegistry,
    vault: SecretVault,
  ): Promise<boolean> {
    const version = getVersion(this.#options.db, scope, serverId, versionId)
    if (!version) return false
    try {
      const loaded = await loadSpec(version.yamlText, {
        fileName: `v${version.number}`,
        secrets: this.#options.secrets.source(scope, serverId),
        vault,
        network: this.#options.network,
        allowSecretsOverHttp: this.#options.allowSecretsOverHttp === true,
      })
      registry.serverInfo = { name: loaded.spec.name, version: loaded.spec.version }
      applySpec(registry, loaded)
      return true
    } catch {
      return false
    }
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
