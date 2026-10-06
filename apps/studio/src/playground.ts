import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const PLAYGROUND_TOKEN_TTL_MS = 15 * 60 * 1000

export interface PlaygroundGrant {
  workspaceId: string
  serverId: string
  versionId: string
  userId: string
  expiresAt: number
}

/**
 * Short-lived tokens that let a signed-in user's browser call one version of one server (a draft
 * too) through the gateway. Signed with a key that exists only in this process: a restart
 * invalidates every token, which is fine for 15-minute tokens.
 */
export class PlaygroundTokens {
  readonly #key = randomBytes(32)

  issue(
    grant: Omit<PlaygroundGrant, "expiresAt">,
    now = Date.now(),
  ): { token: string; expiresAt: number } {
    const expiresAt = now + PLAYGROUND_TOKEN_TTL_MS
    const payload = Buffer.from(JSON.stringify({ ...grant, expiresAt })).toString("base64url")
    return { token: `kvp_${payload}.${this.#sign(payload)}`, expiresAt }
  }

  /** The grant a token carries, if it is genuine and has not expired. */
  verify(token: string, now = Date.now()): PlaygroundGrant | undefined {
    if (!token.startsWith("kvp_") || token.length > 1024) return undefined
    const [payload, signature, extra] = token.slice(4).split(".")
    if (!payload || !signature || extra !== undefined) return undefined
    const expected = Buffer.from(this.#sign(payload), "base64url")
    const actual = Buffer.from(signature, "base64url")
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined
    try {
      const grant = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as PlaygroundGrant
      const fields = [grant.workspaceId, grant.serverId, grant.versionId, grant.userId]
      if (!fields.every((field) => typeof field === "string")) return undefined
      if (typeof grant.expiresAt !== "number" || now >= grant.expiresAt) return undefined
      return grant
    } catch {
      return undefined
    }
  }

  #sign(payload: string): string {
    return createHmac("sha256", this.#key)
      .update(`kervan-playground:${payload}`)
      .digest("base64url")
  }
}
