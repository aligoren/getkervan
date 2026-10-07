// Test-only timing control for the race tests: lets a test pause one password hash or check
// (after it is computed) so a second request can run in between, deterministically. Used with
// `vi.mock("../../src/crypto.js", ...)` in the test files; nothing in src/ is changed.

export type HoldKind = "hash" | "verify"

interface Hold {
  kind: HoldKind
  password: string
  reached: () => void
  released: Promise<void>
}

export const holdState: { current: Hold | undefined } = { current: undefined }

/**
 * Arms a one-shot pause: the next `kind` call for `password` computes its result, then waits
 * until `release()` before returning it. `reached` resolves once that call is paused.
 */
export function arm(kind: HoldKind, password: string) {
  let reached!: () => void
  let release!: () => void
  const reachedPromise = new Promise<void>((resolve) => {
    reached = resolve
  })
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  holdState.current = { kind, password, reached, released }
  return { reached: reachedPromise, release }
}

/** Called by the mocked crypto functions after computing their result. */
export async function maybeHold(kind: HoldKind, password: string): Promise<void> {
  const hold = holdState.current
  if (!hold || hold.kind !== kind || hold.password !== password) return
  holdState.current = undefined
  hold.reached()
  await hold.released
}
