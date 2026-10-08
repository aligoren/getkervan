import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import type { SecretSource } from "@kervan/spec-runtime"
import { and, eq } from "drizzle-orm"
import type { Db } from "./db/open.js"
import { secrets } from "./db/schema.js"
import type { WorkspaceScope } from "./db/scope.js"
import type { KeyProvider } from "./keys.js"
import {
  boundSource,
  checkSecretInput,
  checkSecretName,
  normalizeAllowedHosts,
  type SecretBinding,
  SecretInputError,
  type SecretWrite,
  type WritableSecretStore,
} from "./secrets.js"

export class VaultError extends Error {
  override name = "VaultError"
}

/**
 * Secrets encrypted at rest with AES-256-GCM under a versioned master key. Each row is bound to
 * its workspace, server and name as associated data, so a ciphertext copied to another row does
 * not decrypt. Values are never returned except to the runtime source, for an allowed host.
 */
export class DbSecretStore implements WritableSecretStore {
  readonly #db: Db
  readonly #keys: KeyProvider

  constructor(db: Db, keys: KeyProvider) {
    this.#db = db
    this.#keys = keys
  }

  async put(
    scope: WorkspaceScope,
    serverId: string,
    input: SecretWrite,
    now = Date.now(),
  ): Promise<{ binding: SecretBinding; created: boolean; rotated: boolean }> {
    const allowedHosts = normalizeAllowedHosts(input.allowedHosts)
    const existing = this.#row(scope, serverId, input.name)
    if (input.value === undefined && !existing) {
      throw new SecretInputError("A new secret needs a value.")
    }
    if (input.value !== undefined) checkSecretInput(input.name, input.value)
    else checkSecretName(input.name)
    const sealed =
      input.value === undefined ? undefined : this.#seal(scope, serverId, input.name, input.value)
    const values = {
      allowedHosts: JSON.stringify(allowedHosts),
      updatedAt: now,
      ...(sealed ?? {}),
    }
    if (existing) {
      this.#db.update(secrets).set(values).where(eq(secrets.id, existing.id)).run()
    } else if (sealed) {
      this.#db
        .insert(secrets)
        .values({
          id: crypto.randomUUID(),
          workspaceId: scope.workspaceId,
          serverId,
          name: input.name,
          createdAt: now,
          ...values,
          ...sealed,
        })
        .run()
    }
    return {
      binding: { name: input.name, allowedHosts, updatedAt: now },
      created: !existing,
      rotated: Boolean(existing && sealed),
    }
  }

  async remove(scope: WorkspaceScope, serverId: string, name: string): Promise<boolean> {
    return (
      this.#db
        .delete(secrets)
        .where(
          and(
            eq(secrets.workspaceId, scope.workspaceId),
            eq(secrets.serverId, serverId),
            eq(secrets.name, name),
          ),
        )
        .run().changes === 1
    )
  }

  async list(scope: WorkspaceScope, serverId: string): Promise<SecretBinding[]> {
    return this.#db
      .select({
        name: secrets.name,
        allowedHosts: secrets.allowedHosts,
        updatedAt: secrets.updatedAt,
      })
      .from(secrets)
      .where(and(eq(secrets.workspaceId, scope.workspaceId), eq(secrets.serverId, serverId)))
      .orderBy(secrets.name)
      .all()
      .map((row) => ({ ...row, allowedHosts: JSON.parse(row.allowedHosts) as string[] }))
  }

  source(scope: WorkspaceScope, serverId: string): SecretSource {
    return boundSource((name) => {
      const row = this.#row(scope, serverId, name)
      if (!row) return undefined
      return {
        value: this.#open(scope, serverId, name, row),
        allowedHosts: JSON.parse(row.allowedHosts) as string[],
      }
    })
  }

  /**
   * Checks at startup that every stored secret decrypts with the configured keys, and re-encrypts
   * rows written under an older key version with the current one. Returns how many it rewrapped.
   * Throws if any row cannot be read: Studio must not run with secrets it cannot use or protect.
   */
  verifyAndRewrap(now = Date.now(), options: { rewrap?: boolean } = {}): number {
    const current = this.#keys.current()
    const rewrap = options.rewrap ?? true
    let rewrapped = 0
    for (const row of this.#db.select().from(secrets).all()) {
      const scope = { workspaceId: row.workspaceId } as WorkspaceScope
      let value: string
      try {
        value = this.#open(scope, row.serverId, row.name, row)
      } catch {
        throw new VaultError(
          `Secret ${row.name} (key version ${row.keyVersion}) cannot be decrypted with the ` +
            "configured master keys. Set the right KERVAN_STUDIO_MASTER_KEY (and " +
            "KERVAN_STUDIO_PREVIOUS_MASTER_KEYS for older versions).",
        )
      }
      if (rewrap && row.keyVersion !== current.version) {
        const sealed = this.#seal(scope, row.serverId, row.name, value)
        this.#db
          .update(secrets)
          .set({ ...sealed, updatedAt: now })
          .where(eq(secrets.id, row.id))
          .run()
        rewrapped++
      }
    }
    return rewrapped
  }

  #row(scope: WorkspaceScope, serverId: string, name: string) {
    return this.#db
      .select()
      .from(secrets)
      .where(
        and(
          eq(secrets.workspaceId, scope.workspaceId),
          eq(secrets.serverId, serverId),
          eq(secrets.name, name),
        ),
      )
      .get()
  }

  #seal(scope: WorkspaceScope, serverId: string, name: string, value: string) {
    const { version, key } = this.#keys.current()
    const iv = randomBytes(12)
    const cipher = createCipheriv("aes-256-gcm", key, iv)
    cipher.setAAD(associatedData(scope, serverId, name))
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
    return { ciphertext, iv, tag: cipher.getAuthTag(), keyVersion: version }
  }

  #open(
    scope: WorkspaceScope,
    serverId: string,
    name: string,
    row: { ciphertext: Buffer; iv: Buffer; tag: Buffer; keyVersion: number },
  ): string {
    const key = this.#keys.get(row.keyVersion)
    if (!key) throw new VaultError(`No master key with version ${row.keyVersion}.`)
    const decipher = createDecipheriv("aes-256-gcm", key, row.iv)
    decipher.setAAD(associatedData(scope, serverId, name))
    decipher.setAuthTag(row.tag)
    return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8")
  }
}

/** Binds a ciphertext to its row: moving it to another workspace, server or name breaks it. */
function associatedData(scope: WorkspaceScope, serverId: string, name: string): Buffer {
  return Buffer.from(JSON.stringify(["kervan-secret", 1, scope.workspaceId, serverId, name]))
}
