// Text people type and others see: invisible characters are refused in names and emails, and
// escaped visibly where Studio must keep what was sent (a failed sign-in's email). Names cannot
// impersonate another user or a privileged label.
//
// Invisible and lookalike characters are built from code points: none is written literally here.
import { afterEach, describe, expect, it } from "vitest"
import { listAudit } from "../src/db/repos/audit.js"
import {
  hasUnsafeCharacters,
  identitySkeleton,
  sanitizeDisplayText,
  unsafeTextProblem,
} from "../src/display-text.js"
import { type ApiStudio, apiStudio } from "./api-helpers.js"

const ch = (...codePoints: number[]) => String.fromCodePoint(...codePoints)
const RLO = ch(0x202e)
const ZWSP = ch(0x200b)
/** "ADMIN" in full-width letters. */
const FULL_WIDTH_ADMIN = ch(...[..."ADMIN"].map((letter) => (letter.codePointAt(0) ?? 0) + 0xfee0))

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

describe("sanitizeDisplayText", () => {
  it.each([
    ["line feed", 0x000a, "\\u000A"],
    ["carriage return", 0x000d, "\\u000D"],
    ["tab", 0x0009, "\\u0009"],
    ["NUL", 0x0000, "\\u0000"],
    ["escape (C0)", 0x001b, "\\u001B"],
    ["delete", 0x007f, "\\u007F"],
    ["next line (C1)", 0x0085, "\\u0085"],
    ["control sequence introducer (C1)", 0x009b, "\\u009B"],
    ["line separator", 0x2028, "\\u2028"],
    ["paragraph separator", 0x2029, "\\u2029"],
    ["left-to-right embedding", 0x202a, "\\u202A"],
    ["right-to-left embedding", 0x202b, "\\u202B"],
    ["pop directional formatting", 0x202c, "\\u202C"],
    ["left-to-right override", 0x202d, "\\u202D"],
    ["right-to-left override", 0x202e, "\\u202E"],
    ["left-to-right isolate", 0x2066, "\\u2066"],
    ["right-to-left isolate", 0x2067, "\\u2067"],
    ["first strong isolate", 0x2068, "\\u2068"],
    ["pop directional isolate", 0x2069, "\\u2069"],
    ["left-to-right mark", 0x200e, "\\u200E"],
    ["right-to-left mark", 0x200f, "\\u200F"],
    ["Arabic letter mark", 0x061c, "\\u061C"],
    ["zero-width space", 0x200b, "\\u200B"],
    ["zero-width non-joiner", 0x200c, "\\u200C"],
    ["zero-width joiner", 0x200d, "\\u200D"],
    ["word joiner", 0x2060, "\\u2060"],
    ["byte order mark", 0xfeff, "\\uFEFF"],
    ["soft hyphen", 0x00ad, "\\u00AD"],
    ["Mongolian vowel separator", 0x180e, "\\u180E"],
    ["Hangul filler", 0x3164, "\\u3164"],
    ["braille blank", 0x2800, "\\u2800"],
    ["tag letter (outside the BMP)", 0xe0041, "\\u{E0041}"],
  ])("escapes the %s visibly", (_name, codePoint, escaped) => {
    const text = `a${ch(codePoint)}b`
    expect(hasUnsafeCharacters(text)).toBe(true)
    expect(sanitizeDisplayText(text, 100)).toBe(`a${escaped}b`)
    expect(hasUnsafeCharacters(sanitizeDisplayText(text, 100))).toBe(false)
  })

  it("leaves ordinary text alone, letters of any script and emoji included", () => {
    for (const text of [
      "ayse@example.com",
      "Ayşe Yılmaz",
      "Ünal Çağrı",
      "東京",
      "café ☕",
      "🙂 team",
    ]) {
      expect(hasUnsafeCharacters(text)).toBe(false)
      expect(sanitizeDisplayText(text, 100)).toBe(text)
    }
  })

  it("doubles backslashes, so typed text cannot pass for an escape", () => {
    expect(sanitizeDisplayText("a\\u202Eb", 100)).toBe("a\\\\u202Eb")
    expect(sanitizeDisplayText(`a${RLO}b`, 100)).not.toBe(sanitizeDisplayText("a\\u202Eb", 100))
  })

  it("applies the length limit after escaping, never splitting an escape or an emoji", () => {
    // 10 characters that become 60 once escaped.
    const out = sanitizeDisplayText(RLO.repeat(10), 20)
    expect(out.length).toBeLessThanOrEqual(20)
    expect(out).toMatch(/^(\\u202E)+…$/)
    expect(sanitizeDisplayText("x".repeat(400), 320)).toBe(`${"x".repeat(319)}…`)
    expect(sanitizeDisplayText("x".repeat(320), 320)).toBe("x".repeat(320))
    expect(sanitizeDisplayText(`${"a".repeat(18)}🙂🙂`, 20)).toBe(`${"a".repeat(18)}…`)
  })

  it("explains a refusal with the code point", () => {
    expect(unsafeTextProblem("ok", "The name")).toBeUndefined()
    expect(unsafeTextProblem(`a${RLO}b`, "The name")).toBe(
      "The name contains an invisible or control character (U+202E). Remove it and try again.",
    )
  })
})

describe("identitySkeleton", () => {
  it("makes lookalikes compare equal", () => {
    for (const lookalike of [
      "Admin",
      "ADMIN",
      `Adm${ch(0x0131)}n`, // Turkish dotless i
      `ADM${ch(0x0130)}N`, // Turkish capital I with a dot
      FULL_WIDTH_ADMIN,
      "a d m i n",
      "adm1n",
      `${ch(0x0430)}dmin`, // Cyrillic a
      `admin${ZWSP}`,
      `A${ch(0x0308)}dmin`, // a with a combining diaeresis
    ]) {
      expect(identitySkeleton(lookalike), JSON.stringify(lookalike)).toBe(identitySkeleton("admin"))
    }
    expect(identitySkeleton("Deniz")).not.toBe(identitySkeleton("admin"))
  })
})

async function setup() {
  const s = apiStudio({ throttle: { accountFailures: 1000, ipFailures: 1000 } })
  studios.push(s)
  await s.addUser("admin@example.test", "admin")
  const memberUser = await s.addUser("member@example.test", "member")
  const admin = await s.signIn("admin@example.test")
  const member = await s.signIn("member@example.test")
  const call = (method: string, path: string, as: typeof admin, body?: unknown) =>
    s.request(method, `/api${path}`, { ...as, ...(body === undefined ? {} : { body }) })
  return { s, admin, member, memberUser, call }
}

describe("a failed sign-in's email", () => {
  it("is stored with invisible characters escaped, and shown that way by the API", async () => {
    const { s, admin, call } = await setup()
    const typed = `Evil\r\nlogin.success admin@example.test${ch(0)}${RLO}txt.moc@x${ZWSP}`
    await s.request("POST", "/api/login", { body: { email: typed, password: "wrong password!" } })
    const row = listAudit(s.database.db, s.scope, { action: "login.failure" })[0]
    const stored = String(row?.details?.email)
    expect(stored).toBe(
      "evil\\u000D\\u000Alogin.success admin@example.test\\u0000\\u202Etxt.moc@x\\u200B",
    )
    expect(hasUnsafeCharacters(stored)).toBe(false)
    const shown = await call("GET", "/audit", admin)
    const event = (shown.json.events as { action: string; details: { email: string } }[]).find(
      (e) => e.action === "login.failure",
    )
    expect(event?.details.email).toBe(stored)
  })
})

describe("names and emails that others see", () => {
  it("refuse invisible characters: display name, server name, key name, emails", async () => {
    const { s, admin, member, memberUser, call } = await setup()
    const refused = [
      await call("PUT", "/profile", member, { displayName: `Deniz${ZWSP}Y` }),
      await call("POST", "/servers", admin, { slug: "w", name: `Weather${RLO}abc` }),
      await call("POST", "/users", admin, {
        email: `new${ZWSP}@example.test`,
        password: "a long enough password",
        role: "member",
      }),
      await call("PUT", `/users/${memberUser.id}/email`, admin, {
        email: `x${ch(0x2066)}@example.test`,
      }),
      await s.request("POST", "/api/setup", {
        body: {
          token: s.setupToken(),
          email: `a${ch(0x00ad)}@example.test`,
          password: "a long password!",
        },
      }),
    ]
    for (const response of refused) {
      expect(response.status, response.text).toBe(400)
      expect(String(response.json.error)).toMatch(
        /invisible or control character \(U\+[0-9A-F]{4}\)/,
      )
    }
    const server = await call("POST", "/servers", admin, { slug: "w", name: "Weather" })
    const serverId = String((server.json.server as { id: string }).id)
    const key = await call("POST", `/servers/${serverId}/keys`, admin, { name: "ci\nprod" })
    expect(key.status).toBe(400)
    expect(String(key.json.error)).toContain("(U+000A)")
    // Identifiers were already limited to plain ASCII: slugs and secret names.
    expect((await call("POST", "/servers", admin, { slug: `w${ZWSP}x`, name: "X" })).status).toBe(
      400,
    )
    const secret = await call("PUT", `/servers/${serverId}/secrets/API${ZWSP}KEY`, admin, {
      value: "a-secret-value-123",
      allowedHosts: ["api.example.com"],
    })
    expect(secret.status).toBe(400)
  })

  it("a display name cannot be a reserved label or another user's email, in any lookalike form", async () => {
    const { admin, member, memberUser, call } = await setup()
    for (const name of [
      "admin",
      `Adm${ch(0x0131)}n`,
      FULL_WIDTH_ADMIN,
      "a d m i n",
      `${ch(0x0430)}dmin`,
      "Administrator",
      "Kervan Studio",
      "SYSTEM",
    ]) {
      const response = await call("PUT", "/profile", member, { displayName: name })
      expect(response.status, JSON.stringify(name)).toBe(400)
      expect(String(response.json.error), JSON.stringify(name)).toContain("is reserved")
    }
    for (const name of [
      "ADMIN@example.test",
      `adm${ch(0x0131)}n@example.test`,
      `${ch(0x0430)}dmin@${ch(0x0435, 0x0445)}ample.test`,
      " admin@example.test ",
    ]) {
      const response = await call("PUT", "/profile", member, { displayName: name })
      expect(response.status, JSON.stringify(name)).toBe(400)
      expect(String(response.json.error)).toBe("A display name cannot be another user's email.")
    }
    // Your own email, and an ordinary name, are fine.
    expect(
      (await call("PUT", "/profile", member, { displayName: "member@example.test" })).status,
    ).toBe(200)
    expect((await call("PUT", "/profile", member, { displayName: "Deniz Yılmaz" })).status).toBe(
      200,
    )
    // Nothing was stored by the refused attempts.
    const users = (await call("GET", "/users", admin)).json.users as {
      id: string
      displayName: string | null
    }[]
    expect(users.find((u) => u.id === memberUser.id)?.displayName).toBe("Deniz Yılmaz")
  })

  it("an email cannot be given that reads as someone's display name (the other direction)", async () => {
    const { admin, member, memberUser, call } = await setup()
    expect(
      (await call("PUT", "/profile", member, { displayName: "boss@example.test" })).status,
    ).toBe(200)
    const created = await call("POST", "/users", admin, {
      email: "BOSS@example.test",
      password: "a long enough password",
      role: "member",
    })
    expect(created.status).toBe(409)
    expect(String(created.json.error)).toBe("That email reads like another user's display name.")
    // The member themselves may take it as their email.
    expect(
      (await call("PUT", `/users/${memberUser.id}/email`, admin, { email: "boss@example.test" }))
        .status,
    ).toBe(200)
  })
})
