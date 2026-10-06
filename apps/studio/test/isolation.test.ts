import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { sha256 } from "../src/crypto.js"
import { createApiKey, listApiKeys, revokeApiKey } from "../src/db/repos/api-keys.js"
import { listAudit, recordAudit } from "../src/db/repos/audit.js"
import {
  deleteServer,
  getServer,
  listServers,
  setPublishedVersion,
} from "../src/db/repos/servers.js"
import { createSession } from "../src/db/repos/sessions.js"
import { createUser } from "../src/db/repos/users.js"
import { getVersion, listVersions, saveVersion } from "../src/db/repos/versions.js"
import { createWorkspace } from "../src/db/repos/workspaces.js"
import { MAX_STREAMS_PER_CALLER } from "../src/gateway.js"
import { PLAYGROUND_TOKEN_TTL_MS } from "../src/playground.js"
import { StudioError } from "../src/studio.js"
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
  unpublishedKey,
  user,
} from "./helpers.js"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let upstream: Upstream
beforeAll(async () => {
  upstream = await startUpstream()
})
afterAll(() => upstream.close())

let t: TestStudio
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

async function twoWorkspaces() {
  t = await startTestStudio()
  closers.push(t.close)
  const base = `http://api.test:${upstream.port}`
  const a = await publishedServer(t, spec(echoTool(`${base}/echo/a`, "a_tool")), { slug: "a" })
  const b = await publishedServer(t, spec(echoTool(`${base}/echo/b`, "b_tool")), { slug: "b" })
  return { a, b }
}

describe("repositories stay inside their workspace", () => {
  it("cannot read, change or delete another workspace's rows by id", async () => {
    const { a, b } = await twoWorkspaces()
    const db = t.database.db
    // Workspace A's scope with workspace B's ids.
    expect(getServer(db, a.scope, b.server.id)).toBeUndefined()
    expect(listServers(db, a.scope).map((server) => server.id)).toEqual([a.server.id])
    expect(getVersion(db, a.scope, b.server.id, b.version.id)).toBeUndefined()
    expect(listVersions(db, a.scope, b.server.id)).toEqual([])
    expect(saveVersion(db, a.scope, b.server.id, "x", null)).toBeUndefined()
    expect(setPublishedVersion(db, a.scope, b.server.id, a.version.id)).toBe(false)
    expect(createApiKey(db, a.scope, { serverId: b.server.id, name: "x", createdBy: null })).toBe(
      undefined,
    )
    const bKey = listApiKeys(db, b.scope, b.server.id)[0]
    expect(listApiKeys(db, a.scope, b.server.id)).toEqual([])
    expect(revokeApiKey(db, a.scope, bKey?.id ?? "")).toBe(false)
    expect(deleteServer(db, a.scope, b.server.id)).toBe(false)
    // B is untouched.
    expect(getServer(db, b.scope, b.server.id)?.publishedVersionId).toBe(b.version.id)
    expect(listApiKeys(db, b.scope, b.server.id)[0]?.revokedAt).toBeNull()
  })

  it("does not mix a version of one server into another server of the same workspace", async () => {
    t = await startTestStudio()
    closers.push(t.close)
    const scope = createWorkspace(t.database.db, "w")
    const one = t.studio.createServer(scope, { slug: "one", name: "One" }, user())
    const two = t.studio.createServer(scope, { slug: "two", name: "Two" }, user())
    const v = t.studio.saveVersion(scope, one.id, spec(echoTool("https://x.test/")), user())
    await expect(t.studio.publish(scope, two.id, v.id, user())).rejects.toMatchObject({
      code: "not_found",
    })
    await expect(t.studio.exportVersion(scope, two.id, v.id)).rejects.toBeInstanceOf(StudioError)
  })

  it("keeps audit events per workspace", async () => {
    const { a, b } = await twoWorkspaces()
    recordAudit(t.database.db, b.scope, { type: "system" }, { action: "only.b" })
    expect(listAudit(t.database.db, a.scope).map((event) => event.action)).not.toContain("only.b")
    expect(listAudit(t.database.db, b.scope).map((event) => event.action)).toContain("only.b")
  })
})

describe("services refuse another workspace's ids", () => {
  it("answers not found, never acting on the other workspace", async () => {
    const { a, b } = await twoWorkspaces()
    const s = t.studio
    const attempts: [string, () => unknown][] = [
      ["save", () => s.saveVersion(a.scope, b.server.id, "x", user())],
      ["validate", () => s.validate(a.scope, b.server.id, b.version.id)],
      ["publish", () => s.publish(a.scope, b.server.id, b.version.id, user())],
      ["export", () => s.exportVersion(a.scope, b.server.id, b.version.id)],
      ["key", () => s.createApiKey(a.scope, b.server.id, "x", user())],
      ["delete", () => s.deleteServer(a.scope, b.server.id, user())],
    ]
    for (const [name, attempt] of attempts) {
      const error = await Promise.resolve()
        .then(attempt)
        .then(() => undefined)
        .catch((e: unknown) => e)
      expect(error, name).toBeInstanceOf(StudioError)
      expect((error as StudioError).code, name).toBe("not_found")
    }
    const c = await connect(b.mcpUrl, b.key)
    closers.push(() => c.close())
    expect((await c.listTools()).tools.map((tool) => tool.name)).toEqual(["b_tool"])
  })
})

describe("the gateway keeps servers apart", () => {
  it("accepts a key only on its own server, with the same answer as an invalid key", async () => {
    const { a, b } = await twoWorkspaces()
    const auth = (key: string) => ({ authorization: `Bearer ${key}` })
    const crossed = await postToolsList(b.mcpUrl, auth(a.key))
    const invalid = await postToolsList(b.mcpUrl, auth(`kvn_${"A".repeat(43)}`))
    const unknown = await postToolsList(
      new URL(`/s/${crypto.randomUUID()}/mcp`, t.url),
      auth(a.key),
    )
    for (const response of [crossed, invalid, unknown]) {
      expect(response.status).toBe(401)
    }
    const bodies = await Promise.all([crossed, invalid, unknown].map((r) => r.text()))
    expect(new Set(bodies).size).toBe(1)
    expect(bodies[0]).not.toMatch(/b_tool|weather|workspace/i)
  })

  it("answers a fixed 404 for a server that has a key but is not published", async () => {
    t = await startTestStudio()
    closers.push(t.close)
    const scope = createWorkspace(t.database.db, "w")
    const server = t.studio.createServer(scope, { slug: "draft", name: "Draft" }, user())
    t.studio.saveVersion(scope, server.id, spec(echoTool("https://x.test/")), user())
    const key = unpublishedKey(t, scope, server.id)
    const response = await postToolsList(new URL(`/s/${server.id}/mcp`, t.url), {
      authorization: `Bearer ${key}`,
    })
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Not found" },
      id: null,
    })
  })

  it("serves each server only its own tools, in both eras", async () => {
    const { a, b } = await twoWorkspaces()
    for (const era of ["modern", "legacy"] as const) {
      const ca = await connect(a.mcpUrl, a.key, era)
      const cb = await connect(b.mcpUrl, b.key, era)
      closers.push(
        () => ca.close(),
        () => cb.close(),
      )
      expect((await ca.listTools()).tools.map((tool) => tool.name)).toEqual(["a_tool"])
      expect((await cb.listTools()).tools.map((tool) => tool.name)).toEqual(["b_tool"])
      const crossCall = await ca
        .callTool({ name: "b_tool", arguments: {} })
        .then((result) => JSON.stringify(result))
        .catch((error: unknown) => String(error))
      expect(crossCall).not.toContain("/echo/b")
    }
  })

  it("does not deliver one server's list_changed to another", async () => {
    const { a, b } = await twoWorkspaces()
    const ca = await connect(a.mcpUrl, a.key)
    closers.push(() => ca.close())
    let notified = 0
    ca.setNotificationHandler("notifications/tools/list_changed", () => {
      notified++
    })
    await ca.listen({ toolsListChanged: true })
    const v2 = t.studio.saveVersion(
      b.scope,
      b.server.id,
      spec(`${echoTool("https://x.test/a", "b_tool")}${echoTool("https://x.test/b", "b_new")}`),
      user(),
    )
    await t.studio.publish(b.scope, b.server.id, v2.id, user())
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(notified).toBe(0)
  })

  it("ends open streams when a server is deleted", async () => {
    const { a, b } = await twoWorkspaces()
    const gateway = t.studio.gateway
    const ca = await connect(a.mcpUrl, a.key)
    const cb = await connect(b.mcpUrl, b.key)
    closers.push(
      () => ca.close(),
      () => cb.close(),
    )
    await ca.listen({ toolsListChanged: true })
    await cb.listen({ toolsListChanged: true })
    for (let i = 0; i < 50 && gateway.openStreams < 2; i++) await sleep(20)
    expect(gateway.openStreams).toBe(2)
    await t.studio.deleteServer(a.scope, a.server.id, user())
    // Only the deleted server's stream ends.
    expect(gateway.openStreams).toBe(1)
  })

  it("limits how many streams one key holds open", async () => {
    const { a } = await twoWorkspaces()
    const gateway = t.studio.gateway
    for (let i = 0; i < MAX_STREAMS_PER_CALLER; i++) {
      const client = await connect(a.mcpUrl, a.key)
      closers.push(() => client.close())
      await client.listen({ toolsListChanged: true })
    }
    for (let i = 0; i < 100 && gateway.openStreams < MAX_STREAMS_PER_CALLER; i++) await sleep(20)
    expect(gateway.openStreams).toBe(MAX_STREAMS_PER_CALLER)
    const extra = await connect(a.mcpUrl, a.key)
    closers.push(() => extra.close())
    await expect(extra.listen({ toolsListChanged: true })).rejects.toThrow()
    expect(gateway.openStreams).toBe(MAX_STREAMS_PER_CALLER)
    // Ordinary requests still work.
    expect((await extra.listTools()).tools.map((tool) => tool.name)).toEqual(["a_tool"])
  })

  it("ends a playground stream when its token expires", async () => {
    const { a } = await twoWorkspaces()
    const db = t.database.db
    const gateway = t.studio.gateway
    const owner = createUser(db, a.scope, {
      email: "player@example.test",
      passwordHash: "unused",
      role: "member",
    })
    const session = createSession(db, a.scope, owner.id)
    // A token with about two seconds left.
    const { token } = t.studio.playground.issue(
      {
        workspaceId: a.scope.workspaceId,
        serverId: a.server.id,
        versionId: a.version.id,
        userId: owner.id,
        sessionHash: sha256(session.id),
      },
      Date.now() - PLAYGROUND_TOKEN_TTL_MS + 2000,
    )
    const client = await connect(a.mcpUrl, token)
    closers.push(() => client.close())
    await client.listen({ toolsListChanged: true })
    for (let i = 0; i < 50 && gateway.openStreams < 1; i++) await sleep(20)
    expect(gateway.openStreams).toBe(1)
    for (let i = 0; i < 100 && gateway.openStreams > 0; i++) await sleep(50)
    expect(gateway.openStreams).toBe(0)
  })

  it("stops serving a deleted server at once", async () => {
    const { a } = await twoWorkspaces()
    const auth = { authorization: `Bearer ${a.key}` }
    expect((await postToolsList(a.mcpUrl, auth)).status).toBe(200)
    await t.studio.deleteServer(a.scope, a.server.id, user())
    // The key went with the server (cascade), so the answer is the same 401 as any bad key.
    expect((await postToolsList(a.mcpUrl, auth)).status).toBe(401)
  })
})
