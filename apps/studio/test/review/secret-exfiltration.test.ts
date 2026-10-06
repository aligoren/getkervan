// Security review (phase 4a): can a member (writes and publishes specs, never sees secret values)
// get a bound secret out through Studio's gateway? Every test asserts the secure behavior; a
// failing test is a demonstrated gap.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createWorkspace } from "../../src/db/repos/workspaces.js"
import {
  connect,
  resultText,
  startTestStudio,
  startUpstream,
  type TestStudio,
  type Upstream,
  user,
} from "../helpers.js"

const SECRET = "sk-studio-0123456789abcdef"
let upstream: Upstream
beforeAll(async () => {
  upstream = await startUpstream()
})
afterAll(() => upstream.close())

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** A server whose admin bound API_KEY to bound.test only; the member publishes `text`. */
async function memberServer(text: string, options: { production?: boolean } = {}) {
  // Most of these tests need the local http API; "production" uses Studio's real http policy.
  const t: TestStudio = await startTestStudio(
    options.production ? { allowSecretsOverHttp: false } : {},
  )
  cleanups.push(t.close)
  const scope = createWorkspace(t.database.db, "w")
  const server = t.studio.createServer(scope, { slug: "s", name: "S" }, user())
  t.secrets.set(scope, server.id, {
    name: "API_KEY",
    value: SECRET,
    allowedHosts: [`bound.test:${upstream.port}`],
  })
  const version = t.studio.saveVersion(scope, server.id, text, user("member"))
  let published = true
  try {
    await t.studio.publish(scope, server.id, version.id, user("member"))
  } catch {
    published = false
  }
  const { key } = t.studio.createApiKey(scope, server.id, "k", user())
  const mcpUrl = new URL(`/s/${server.id}/mcp`, t.url)
  return { t, published, key, mcpUrl }
}

async function callOnce(mcpUrl: URL, key: string, era: "modern" | "legacy" = "modern") {
  const client = await connect(mcpUrl, key, era)
  cleanups.push(() => client.close())
  return resultText(await client.callTool({ name: "call", arguments: {} }))
}

/** The bound host (the local echo API) reflects X-Key back as `key`. */
const reflecting = (output: string, path = "/echo/reflect") => `specVersion: 1
name: member
version: 1.0.0
secrets: [API_KEY]
defaults: { http: { allowInsecureHttp: true, timeoutMs: 2000 } }
tools:
  - name: call
    description: Calls the bound API
    http:
      url: http://bound.test:${upstream.port}${path}
      headers: { X-Key: "{{secrets.API_KEY}}" }
    output: ${output}`

describe("review: tool results never contain a transformed secret (T2)", () => {
  it.each(["modern", "legacy"] as const)(
    "baseline: the reflected value itself is redacted (%s)",
    async (era) => {
      const s = await memberServer(reflecting('{ select: "key" }'))
      expect(await callOnce(s.mcpUrl, s.key, era)).not.toContain(SECRET)
    },
  )

  it.each([
    ["upper(key)", SECRET.toUpperCase()],
    ["key[::-1]", [...SECRET].reverse().join("")],
    ['join(`""`, [key[0:3], `"*"`, key[3:]])', `${SECRET.slice(0, 3)}*${SECRET.slice(3)}`],
  ])("does not return the secret reshaped by select: %s", async (select, leaked) => {
    const s = await memberServer(reflecting(`{ select: '${select}' }`))
    expect(s.published).toBe(true)
    expect(await callOnce(s.mcpUrl, s.key)).not.toContain(leaked)
  })

  it("does not act as an oracle on the secret's characters", async () => {
    const s = await memberServer(reflecting("{ select: 'starts_with(key, `\"sk-studio-0\"`)' }"))
    expect(await callOnce(s.mcpUrl, s.key)).not.toBe("true")
  })

  it("does not leak a prefix of the secret when output is truncated through it", async () => {
    const prefix = `{"path":"/echo/trunc","query":{},"key":"`
    const s = await memberServer(
      reflecting(`{ raw: true, maxOutputChars: ${prefix.length + 14} }`, "/echo/trunc"),
    )
    expect(await callOnce(s.mcpUrl, s.key)).not.toContain(SECRET.slice(0, 14))
  })
})

describe("review: a bound secret only travels encrypted (T1, network attacker)", () => {
  it("does not let a member send a bound secret over plain http", async () => {
    // The admin bound API_KEY to bound.test, expecting it to go to that API over TLS. The member
    // sets allowInsecureHttp, so anyone on the path between Studio and bound.test can read it.
    const s = await memberServer(reflecting('{ select: "path" }', "/echo/plaintext"), {
      production: true,
    })
    if (s.published) await callOnce(s.mcpUrl, s.key)
    const cleartext = upstream.requests.filter(
      (r) => r.path === "/echo/plaintext" && r.headers["x-key"] === SECRET,
    )
    expect(s.published).toBe(false)
    expect(cleartext).toEqual([])
  })
})
