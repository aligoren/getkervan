import { normalizeHostPort, type SecretSource, SPEC_LIMITS } from "@kervan/spec-runtime"
import type { WorkspaceScope } from "./db/scope.js"

/** What Studio shows about a secret: never its value. */
export interface SecretBinding {
  name: string
  /** Normalized `host:port` entries the value may be sent to; never empty. */
  allowedHosts: readonly string[]
  updatedAt: number
}

/**
 * Per-server secrets. The bindings (`allowedHosts`) are authoritative: a spec can narrow them
 * with its own `hosts`, never widen them. Values are write-only: nothing here returns one except
 * the runtime source, and only for an allowed host.
 */
export interface SecretStore {
  list(scope: WorkspaceScope, serverId: string): Promise<SecretBinding[]>
  /** The source a server's tools resolve `{{secrets.X}}` from. */
  source(scope: WorkspaceScope, serverId: string): SecretSource
}

/** A create, rotate (new value) or rebind (new hosts) request. `value` is optional when updating. */
export interface SecretWrite {
  name: string
  value?: string | undefined
  allowedHosts: readonly string[]
}

/**
 * A store the management API can write to. Writes never return the value. `within` runs right
 * before the write, in the same synchronous step (a database store: in its write transaction), and
 * stops it by throwing: Studio checks there that the actor may still write.
 */
export interface WritableSecretStore extends SecretStore {
  put(
    scope: WorkspaceScope,
    serverId: string,
    input: SecretWrite,
    now?: number,
    within?: () => void,
  ): Promise<{ binding: SecretBinding; created: boolean; rotated: boolean }>
  remove(
    scope: WorkspaceScope,
    serverId: string,
    name: string,
    within?: () => void,
  ): Promise<boolean>
}

export class SecretInputError extends Error {
  override name = "SecretInputError"
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/
export const MAX_SECRET_BYTES = 16 * 1024

/** Validates and normalizes a binding's hosts: at least one, each a bare host name. */
export function normalizeAllowedHosts(hosts: readonly string[]): string[] {
  if (hosts.length === 0) {
    throw new SecretInputError("A secret needs at least one allowed host.")
  }
  if (hosts.length > SPEC_LIMITS.maxSecretHosts) {
    throw new SecretInputError(`A secret can have at most ${SPEC_LIMITS.maxSecretHosts} hosts.`)
  }
  const normalized: string[] = []
  for (const host of hosts) {
    const value = normalizeHostPort(host.trim())
    if (value === undefined) {
      throw new SecretInputError(
        `"${host}" is not a host. Use host or host:port, like api.example.com (port 443) or ` +
          "api.example.com:8443: no scheme, path or wildcard.",
      )
    }
    if (!normalized.includes(value)) normalized.push(value)
  }
  return normalized
}

export function checkSecretName(name: string): void {
  if (!SECRET_NAME.test(name)) {
    throw new SecretInputError("Secret names are A-Z, 0-9 and _, starting with a letter.")
  }
}

export function checkSecretInput(name: string, value: string): void {
  checkSecretName(name)
  if (value.length < SPEC_LIMITS.minSecretLength) {
    throw new SecretInputError(
      `A secret value needs at least ${SPEC_LIMITS.minSecretLength} characters.`,
    )
  }
  if (Buffer.byteLength(value) > MAX_SECRET_BYTES) {
    throw new SecretInputError(`A secret value can be at most ${MAX_SECRET_BYTES} bytes.`)
  }
  // Stored as UTF-8, an unpaired surrogate would come back as another character.
  if (/\p{Cs}/u.test(value)) {
    throw new SecretInputError("A secret value must be valid Unicode text (no unpaired surrogate).")
  }
}

/**
 * The host check every store's source applies: no context or a host outside the binding gets
 * nothing, so a value can only leave towards a host an admin allowed.
 */
export function boundSource(
  lookup: (
    name: string,
  ) =>
    | { value: string; allowedHosts: readonly string[] }
    | undefined
    | Promise<{ value: string; allowedHosts: readonly string[] } | undefined>,
): SecretSource {
  return {
    async get(name, context) {
      if (!context) return undefined
      const entry = await lookup(name)
      if (!entry?.allowedHosts.includes(context.host)) return undefined
      return entry.value
    },
  }
}

/** A store kept in memory: for tests and for running Studio without persistence. */
export class InMemorySecretStore implements WritableSecretStore {
  readonly #entries = new Map<
    string,
    { name: string; value: string; allowedHosts: string[]; updatedAt: number }
  >()

  set(
    scope: WorkspaceScope,
    serverId: string,
    input: { name: string; value: string; allowedHosts: readonly string[] },
    now = Date.now(),
  ): SecretBinding {
    checkSecretInput(input.name, input.value)
    const allowedHosts = normalizeAllowedHosts(input.allowedHosts)
    this.#entries.set(key(scope, serverId, input.name), {
      name: input.name,
      value: input.value,
      allowedHosts,
      updatedAt: now,
    })
    return { name: input.name, allowedHosts, updatedAt: now }
  }

  delete(scope: WorkspaceScope, serverId: string, name: string): boolean {
    return this.#entries.delete(key(scope, serverId, name))
  }

  async put(
    scope: WorkspaceScope,
    serverId: string,
    input: SecretWrite,
    now = Date.now(),
    within?: () => void,
  ) {
    within?.()
    const existing = this.#entries.get(key(scope, serverId, input.name))
    const value = input.value ?? existing?.value
    if (value === undefined) throw new SecretInputError("A new secret needs a value.")
    const binding = this.set(
      scope,
      serverId,
      { name: input.name, value, allowedHosts: input.allowedHosts },
      now,
    )
    return { binding, created: !existing, rotated: Boolean(existing && input.value !== undefined) }
  }

  async remove(
    scope: WorkspaceScope,
    serverId: string,
    name: string,
    within?: () => void,
  ): Promise<boolean> {
    within?.()
    return this.delete(scope, serverId, name)
  }

  async list(scope: WorkspaceScope, serverId: string): Promise<SecretBinding[]> {
    const prefix = key(scope, serverId, "")
    return [...this.#entries]
      .filter(([k]) => k.startsWith(prefix))
      .map(([, { name, allowedHosts, updatedAt }]) => ({ name, allowedHosts, updatedAt }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  source(scope: WorkspaceScope, serverId: string): SecretSource {
    return boundSource((name) => this.#entries.get(key(scope, serverId, name)))
  }
}

function key(scope: WorkspaceScope, serverId: string, name: string): string {
  return JSON.stringify([scope.workspaceId, serverId]) + name
}
