// Disabling a server: the gateway serves nothing (published version, playground, open streams),
// nothing is deleted, enabling serves it again; audited; the same rules as publishing. Also the
// call log's caller, and the gateway's one fixed 401 answer.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { sha256 } from "../src/crypto.js"
import { listAudit } from "../src/db/repos/audit.js"
import { createSession } from "../src/db/repos/sessions.js"
import { createUser } from "../src/db/repos/users.js"
import { listVersions } from "../src/db/repos/versions.js"
import { createWorkspace } from "../src/db/repos/workspaces.js"
import { UNAUTHORIZED_MESSAGE } from "../src/gateway.js"
import { type ApiStudio, apiStudio, PASSWORD } from "./api-helpers.js"
import {
  connect,
  echoTool,
  postToolsList,
  publishedServer,
  spec,
  startTestStudio,
  startUpstream,
  type TestStudio,
  type Upstream,
  user,
} from "./helpers.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let upstream: Upstream
beforeAll(async () => {
  upstream = await startUpstream()
})
afterAll(() => upstream.close())

const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

async function served() {
  const t: TestStudio = await startTestStudio()
  closers.push(t.close)
  const a = await publishedServer(
    t,
    spec(echoTool(`http://api.test:${upstream.port}/echo/a`, "a_tool")),
    { slug: "a" },
  )
  const owner = createUser(t.database.db, a.scope, {
    email: "player@example.test",
    passwordHash: "unused",
    role: "member",
  })
  const session = createSession(t.database.db, a.scope, owner.id)
  const playground = () =>
    t.studio.playgroundToken(a.scope, a.server.id, a.version.id, {
      userId: owner.id,
      sessionHash: sha256(session.id),
    }).token
  return { t, a, playground }
}

describe("a disabled server", () => {
  it("answers nothing: published version, valid key, playground, open streams", async () => {
    const { t, a, playground } = await served()
    const gateway = t.studio.gateway
    const playgroundToken = playground()
    const client = await connect(a.mcpUrl, a.key)
    closers.push(() => client.close())
    await client.listen({ toolsListChanged: true })
    for (let i = 0; i < 50 && gateway.openStreams < 1; i++) await sleep(20)
    expect(gateway.openStreams).toBe(1)

    await t.studio.setServerDisabled(a.scope, a.server.id, true, user())

    // The open stream ended, and every way in is a 404, as for a server that does not exist.
    expect(gateway.openStreams).toBe(0)
    const byKey = await postToolsList(a.mcpUrl, { authorization: `Bearer ${a.key}` })
    const byPlayground = await postToolsList(a.mcpUrl, {
      authorization: `Bearer ${playgroundToken}`,
    })
    expect([byKey.status, byPlayground.status]).toEqual([404, 404])
    await expect(connect(a.mcpUrl, a.key)).rejects.toThrow()
    // No new playground session either.
    expect(() => playground()).toThrow("This server is disabled")
    // Publishing a new version does not serve it while disabled.
    const v2 = t.studio.saveVersion(
      a.scope,
      a.server.id,
      spec(echoTool(`http://api.test:${upstream.port}/echo/b`, "b_tool")),
      user(),
    )
    await t.studio.publish(a.scope, a.server.id, v2.id, user())
    expect((await postToolsList(a.mcpUrl, { authorization: `Bearer ${a.key}` })).status).toBe(404)
    // Not even loaded: the gateway serves no version of a disabled server.
    expect(gateway.servedVersion(a.scope, a.server.id)).toBeUndefined()
  })

  it("keeps its versions, secrets and keys, and serves again when enabled", async () => {
    const { t, a, playground } = await served()
    await t.secrets.put(a.scope, a.server.id, {
      name: "API_KEY",
      value: "kept-secret-value-123",
      allowedHosts: ["api.test"],
    })
    await t.studio.setServerDisabled(a.scope, a.server.id, true, user())
    await t.studio.setServerDisabled(a.scope, a.server.id, false, user())
    // The same key as before works again.
    const client = await connect(a.mcpUrl, a.key)
    closers.push(() => client.close())
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["a_tool"])
    expect((await t.secrets.list(a.scope, a.server.id)).map((s) => s.name)).toEqual(["API_KEY"])
    expect(listVersions(t.database.db, a.scope, a.server.id).map((v) => v.number)).toEqual([1])
    expect(
      (await postToolsList(a.mcpUrl, { authorization: `Bearer ${playground()}` })).status,
    ).toBe(200)
  })

  it("is audited once per change", async () => {
    const { t, a } = await served()
    await t.studio.setServerDisabled(a.scope, a.server.id, true, user())
    await t.studio.setServerDisabled(a.scope, a.server.id, true, user())
    await t.studio.setServerDisabled(a.scope, a.server.id, false, user())
    const actions = listAudit(t.database.db, a.scope)
      .map((event) => event.action)
      .filter((action) => action.startsWith("server.") && action.endsWith("able"))
    expect(actions).toEqual(["server.enable", "server.disable"])
  })

  it("cannot be reached from another workspace", async () => {
    const { t, a } = await served()
    const other = createWorkspace(t.database.db, "other")
    await expect(t.studio.setServerDisabled(other, a.server.id, true, user())).rejects.toThrow(
      "Not found",
    )
    expect((await postToolsList(a.mcpUrl, { authorization: `Bearer ${a.key}` })).status).toBe(200)
  })
})

describe("the call log", () => {
  it("records who called: the playground, or an API key by name (never the key)", async () => {
    const { t, a, playground } = await served()
    const byKey = await connect(a.mcpUrl, a.key)
    const byPlayground = await connect(a.mcpUrl, playground())
    closers.push(
      () => byKey.close(),
      () => byPlayground.close(),
    )
    await byKey.callTool({ name: "a_tool", arguments: {} })
    await byPlayground.callTool({ name: "a_tool", arguments: {} })
    const calls = t.studio.listCalls(a.scope, a.server.id, { withPayloads: true })
    expect(
      calls.map((call) => [call.source, "apiKeyName" in call ? call.apiKeyName : null]),
    ).toEqual([
      ["playground", null],
      ["api_key", "test"],
    ])
    expect(JSON.stringify(calls)).not.toContain(a.key)
  })
})

describe("the API", () => {
  async function setup() {
    const s = apiStudio()
    studios.push(s)
    await s.addUser("admin@example.test", "admin")
    await s.addUser("member@example.test", "member")
    const admin = await s.signIn("admin@example.test")
    const member = await s.signIn("member@example.test")
    const server = await s.request("POST", "/api/servers", {
      ...admin,
      body: { slug: "w", name: "W" },
    })
    const id = String((server.json.server as { id: string }).id)
    return { s, admin, member, id }
  }
  const studios: ApiStudio[] = []
  afterEach(async () => {
    for (const s of studios.splice(0)) await s.close()
  })

  it("lets anyone who may publish disable and enable a server, and nobody else", async () => {
    const { s, member, id } = await setup()
    const disabled = await s.request("POST", `/api/servers/${id}/disable`, { ...member, body: {} })
    expect(disabled.status).toBe(200)
    expect((disabled.json.server as { disabledAt: number | null }).disabledAt).toEqual(
      expect.any(Number),
    )
    // No CSRF token, or signed out: refused, on both routes.
    for (const route of ["disable", "enable"]) {
      const noCsrf = await s.request("POST", `/api/servers/${id}/${route}`, {
        cookie: member.cookie,
        body: {},
      })
      const signedOut = await s.request("POST", `/api/servers/${id}/${route}`, { body: {} })
      expect([noCsrf.status, signedOut.status], route).toEqual([403, 401])
    }
    // A user who must change their password first (an admin reset it): refused too.
    await s.request("POST", `/api/users/${await memberId(s)}/password-reset`, {
      ...(await s.signIn("admin@example.test")),
      body: { adminPassword: PASSWORD, password: "temporary password 123" },
    })
    const mustChange = await s.signIn("member@example.test", "temporary password 123")
    const refused = await s.request("POST", `/api/servers/${id}/enable`, {
      ...mustChange,
      body: {},
    })
    expect(refused.status).toBe(403)
    // The admin enables it again; an unknown server is a 404.
    const admin = await s.signIn("admin@example.test")
    expect(
      (await s.request("POST", `/api/servers/${id}/enable`, { ...admin, body: {} })).status,
    ).toBe(200)
    expect(
      (await s.request("POST", "/api/servers/no-such-server/disable", { ...admin, body: {} }))
        .status,
    ).toBe(404)
  })

  it("gives one 401 body, with what to send, for every kind of bad key", async () => {
    const { s, admin, id } = await setup()
    const other = await s.request("POST", "/api/servers", {
      ...admin,
      body: { slug: "o", name: "O" },
    })
    const otherId = String((other.json.server as { id: string }).id)
    const otherKey = String(
      (await s.request("POST", `/api/servers/${otherId}/keys`, { ...admin, body: { name: "k" } }))
        .json.key,
    )
    const created = await s.request("POST", `/api/servers/${id}/keys`, {
      ...admin,
      body: { name: "k" },
    })
    const revokedKey = String(created.json.key)
    await s.request(
      "DELETE",
      `/api/servers/${id}/keys/${(created.json.info as { id: string }).id}`,
      {
        ...admin,
      },
    )
    const ask = (authorization?: string) =>
      s.request("POST", `/s/${id}/mcp`, {
        headers: {
          origin: undefined,
          "sec-fetch-site": undefined,
          accept: "application/json, text/event-stream",
          ...(authorization ? { authorization } : {}),
        },
        body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      })
    const answers = [
      await ask(),
      await ask("Bearer kvn_not-a-real-key-at-all-000000000000000000000"),
      await ask(`Bearer ${revokedKey}`),
      await ask(`Bearer ${otherKey}`),
    ]
    expect(answers.map((answer) => answer.status)).toEqual([401, 401, 401, 401])
    expect(new Set(answers.map((answer) => answer.text)).size).toBe(1)
    expect(answers[0]?.json).toEqual({
      jsonrpc: "2.0",
      error: { code: -32001, message: UNAUTHORIZED_MESSAGE },
      id: null,
    })
    expect(UNAUTHORIZED_MESSAGE).toBe(
      "Unauthorized. Send a valid API key for this server as 'Authorization: Bearer <key>'.",
    )
  })
})

async function memberId(s: ApiStudio): Promise<string> {
  const admin = await s.signIn("admin@example.test")
  const users = (await s.request("GET", "/api/users", admin)).json.users as {
    id: string
    email: string
  }[]
  return users.find((u) => u.email === "member@example.test")?.id ?? ""
}
