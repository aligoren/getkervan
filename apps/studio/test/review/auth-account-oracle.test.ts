// Security review (release): account existence does not leak. Members cannot list users, the
// sign-in page answers the same for known and unknown emails, and so does the display-name check.
import { afterEach, describe, expect, it } from "vitest"
import { type ApiStudio, apiStudio } from "../api-helpers.js"

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

describe("a member's display name", () => {
  it("does not reveal whether an email belongs to a user", async () => {
    const s = apiStudio()
    studios.push(s)
    await s.addUser("ceo@example.test", "admin")
    await s.addUser("member@example.test", "member")
    const member = await s.signIn("member@example.test")
    // Members cannot list users.
    expect((await s.request("GET", "/api/users", member)).status).toBe(403)

    const probe = (displayName: string) =>
      s.request("PUT", "/api/profile", { ...member, body: { displayName } })
    const known = await probe("ceo@example.test")
    const unknown = await probe("nobody@example.test")
    // Folded lookalikes are an oracle too (case, spaces).
    const knownFolded = await probe(" CEO@Example.Test ")

    expect(known.status).toBe(unknown.status)
    expect(knownFolded.status).toBe(unknown.status)
    expect(known.json.error).toBe(unknown.json.error)
    // The same answer is a refusal: a name that reads as an email could pass for its owner.
    expect(unknown.status).toBe(400)
  })
})
