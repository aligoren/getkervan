import { and, eq, gt, isNull } from "drizzle-orm"
import { randomToken, sha256 } from "../../crypto.js"
import type { Db } from "../open.js"
import { oneTimeTokens } from "../schema.js"

export const SETUP_TOKEN_TTL_MS = 30 * 60 * 1000

/**
 * Issues a fresh first-run setup token and invalidates earlier unused ones. Only its hash is
 * stored; the token is printed once to the console of whoever started Studio.
 */
export function issueSetupToken(db: Db, now = Date.now()): { token: string; expiresAt: number } {
  const token = randomToken(32)
  const expiresAt = now + SETUP_TOKEN_TTL_MS
  db.transaction((tx) => {
    tx.update(oneTimeTokens)
      .set({ usedAt: now })
      .where(and(eq(oneTimeTokens.purpose, "setup"), isNull(oneTimeTokens.usedAt)))
      .run()
    tx.insert(oneTimeTokens)
      .values({ hash: sha256(token), purpose: "setup", createdAt: now, expiresAt })
      .run()
  })
  return { token, expiresAt }
}

/**
 * Marks a setup token used if it is valid: known, unused and not expired. Call it in the same
 * transaction that creates the first admin, so one token can never create two.
 */
export function consumeSetupToken(db: Db, token: string, now = Date.now()): boolean {
  if (token.length === 0 || token.length > 100) return false
  const result = db
    .update(oneTimeTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(oneTimeTokens.hash, sha256(token)),
        eq(oneTimeTokens.purpose, "setup"),
        isNull(oneTimeTokens.usedAt),
        gt(oneTimeTokens.expiresAt, now),
      ),
    )
    .run()
  return result.changes === 1
}
