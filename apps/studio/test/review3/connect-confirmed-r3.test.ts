// Security review 3, confirmed: the connect commands the web UI builds (ServerPanels.tsx,
// `connectCommands`) put the server slug, the endpoint and the key into shell text unquoted. That
// is safe only because the server never lets a shell-special character into those values: slugs
// are ASCII [a-z0-9-] (no leading "-", so no option injection), keys are `kvn_` + base64url, and
// the endpoint holds the server id percent-encoded. Here the server is attacked with every special
// of bash/zsh and PowerShell, including the Unicode quotes PowerShell treats as quotes.
import { afterEach, describe, expect, it } from "vitest"
import { API_KEY_PATTERN } from "../../src/db/repos/api-keys.js"
import { type ApiStudio, apiStudio } from "../api-helpers.js"

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

const cp = (...points: number[]) => String.fromCodePoint(...points)

const HOSTILE_SLUGS = [
  "a'b",
  'a"b',
  "a`b",
  "a$b",
  "a$(id)",
  "a;b",
  "a&b",
  "a|b",
  `a${cp(10)}b`,
  `a${cp(13)}b`,
  "a b",
  "$env:x",
  "a@(b)",
  "--%",
  "-e",
  "--transport",
  "a-",
  "A",
  `a${cp(0x2018)}b`,
  `a${cp(0x2019)}b`,
  `a${cp(0x201c)}b`,
  `a${cp(0x201d)}b`,
  `a${cp(0x201e)}b`,
  `a${cp(0x2013)}b`,
  `a${cp(0xff04)}b`,
  "a*b",
  "a[1]",
  "a{b,c}",
  "a~",
  "a#b",
  "a\\b",
  "a>b",
  "a<b",
  "a(b)",
  "a!b",
  "a^b",
  "a%b",
  "a,b",
  "a=b",
  "a.b",
  "a/b",
  "a:b",
  `a${cp(0x131)}`,
  `${"a".repeat(65)}`,
]

describe("values that reach the connect command", () => {
  it("never include a shell-special character in a slug the server accepts", async () => {
    const s = apiStudio()
    studios.push(s)
    await s.addUser("admin@example.test", "admin")
    const admin = await s.signIn("admin@example.test")
    const accepted: string[] = []
    for (const slug of HOSTILE_SLUGS) {
      const created = await s.request("POST", "/api/servers", {
        ...admin,
        body: { slug, name: "x" },
      })
      if (created.status !== 400) accepted.push(JSON.stringify(slug))
    }
    expect(accepted).toEqual([])
  })

  it("never include one in an API key or a server id", async () => {
    const s = apiStudio()
    studios.push(s)
    await s.addUser("admin@example.test", "admin")
    const admin = await s.signIn("admin@example.test")
    const created = await s.request("POST", "/api/servers", {
      ...admin,
      body: { slug: "srv-1", name: "x" },
    })
    const serverId = (created.json.server as { id: string }).id
    expect(serverId).toMatch(/^[0-9a-f-]{36}$/)
    for (let i = 0; i < 20; i++) {
      const key = await s.request("POST", `/api/servers/${serverId}/keys`, {
        ...admin,
        body: { name: `k${i}` },
      })
      expect(String(key.json.key)).toMatch(API_KEY_PATTERN)
      expect(String(key.json.key)).toMatch(/^kvn_[A-Za-z0-9_-]+$/)
    }
  })
})
