// The setup endpoint checks its token before hashing the password: scrypt is slow on purpose, and
// guesses with wrong tokens should not cost the server a hash each.
import { afterEach, describe, expect, it, vi } from "vitest"
import { type ApiStudio, apiStudio, PASSWORD } from "./api-helpers.js"

const hashes = vi.hoisted(() => ({ count: 0 }))
vi.mock("../src/crypto.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/crypto.js")>()
  return {
    ...original,
    hashPassword: (password: string) => {
      hashes.count++
      return original.hashPassword(password)
    },
  }
})

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

describe("setup", () => {
  it("does not hash the password when the token is wrong", async () => {
    const s = apiStudio()
    studios.push(s)
    const token = s.setupToken()
    hashes.count = 0
    const wrong = await s.request("POST", "/api/setup", {
      body: { token: `${token}x`, email: "a@example.test", password: PASSWORD },
    })
    expect(wrong.status).toBe(403)
    expect(hashes.count).toBe(0)
    const right = await s.request("POST", "/api/setup", {
      body: { token, email: "a@example.test", password: PASSWORD },
    })
    expect(right.status).toBe(201)
    expect(hashes.count).toBe(1)
  })
})
