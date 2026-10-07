// Real names in any script are accepted, stored and returned exactly: the invisible-character and
// lookalike checks (display-text.ts) must not turn away legitimate text.
import { afterEach, describe, expect, it } from "vitest"
import { identitySkeleton, RESERVED_NAMES } from "../src/display-text.js"
import { type ApiStudio, apiStudio } from "./api-helpers.js"

export const LEGITIMATE_NAMES = [
  "Gökçe Şahin",
  "Işık Öztürk",
  "İbrahim",
  "Ayşe",
  "Zoë",
  "李雷",
  "Müller",
  "Ali 🚀",
  "A. Yılmaz",
]

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

async function setup() {
  const s = apiStudio()
  studios.push(s)
  await s.addUser("admin@example.test", "admin")
  const memberUser = await s.addUser("member@example.test", "member")
  const admin = await s.signIn("admin@example.test")
  const member = await s.signIn("member@example.test")
  const call = (method: string, path: string, as: typeof admin, body?: unknown) =>
    s.request(method, `/api${path}`, { ...as, ...(body === undefined ? {} : { body }) })
  return { admin, member, memberUser, call }
}

describe("legitimate Unicode names", () => {
  it("are not mistaken for a reserved label or another user's email", () => {
    const reserved = new Set(RESERVED_NAMES.map(identitySkeleton))
    const emails = new Set(["admin@example.test", "member@example.test"].map(identitySkeleton))
    for (const name of LEGITIMATE_NAMES) {
      expect(reserved.has(identitySkeleton(name)), name).toBe(false)
      expect(emails.has(identitySkeleton(name)), name).toBe(false)
    }
  })

  it("containing a reserved word is fine; only the label itself is refused", async () => {
    const { member, call } = await setup()
    for (const name of [
      "Kervan Yılmaz",
      "Admin Ekibi",
      "Studio Ghibli Hayranı",
      "Rootkit Avcısı",
    ]) {
      const saved = await call("PUT", "/profile", member, { displayName: name })
      expect(saved.status, name).toBe(200)
      expect((saved.json.user as { displayName: string }).displayName).toBe(name)
    }
    expect((await call("PUT", "/profile", member, { displayName: "Kervan" })).status).toBe(400)
  })

  it.each(LEGITIMATE_NAMES)("are kept exactly as display names: %s", async (name) => {
    const { admin, member, memberUser, call } = await setup()
    const saved = await call("PUT", "/profile", member, { displayName: name })
    expect(saved.status, saved.text).toBe(200)
    expect((saved.json.user as { displayName: string }).displayName).toBe(name)
    expect(
      ((await call("GET", "/profile", member)).json.user as { displayName: string }).displayName,
    ).toBe(name)
    // As other people see it: the admin's user list and the session the user's sidebar reads.
    const users = (await call("GET", "/users", admin)).json.users as {
      id: string
      displayName: string
    }[]
    expect(users.find((user) => user.id === memberUser.id)?.displayName).toBe(name)
    expect(
      ((await call("GET", "/session", member)).json.user as { displayName: string }).displayName,
    ).toBe(name)
  })

  it.each(LEGITIMATE_NAMES)("are kept exactly as server and API key names: %s", async (name) => {
    const { admin, call } = await setup()
    const server = await call("POST", "/servers", admin, { slug: "s", name })
    expect(server.status, server.text).toBe(201)
    const serverId = String((server.json.server as { id: string }).id)
    const listed = (await call("GET", "/servers", admin)).json.servers as { name: string }[]
    expect(listed.map((s) => s.name)).toEqual([name])
    const key = await call("POST", `/servers/${serverId}/keys`, admin, { name })
    expect(key.status, key.text).toBe(201)
    const keys = (await call("GET", `/servers/${serverId}/keys`, admin)).json.keys as {
      name: string
    }[]
    expect(keys.map((k) => k.name)).toEqual([name])
  })
})
