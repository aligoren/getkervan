// Independent review: call-log payload redaction (T15) and secret lifecycle (T16) for both the
// published version and playground drafts.
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type ApiStudio, apiStudio, gatewayClient, ORIGIN } from "../api-helpers.js"
import { MODERN, resultText, startUpstream, type Upstream } from "../helpers.js"

const V1 = "sk-lifecycle-first-0123456789"
const V2 = "sk-lifecycle-second-987654321"

let upstream: Upstream
beforeAll(async () => {
  upstream = await startUpstream()
})
afterAll(() => upstream.close())

const studios: ApiStudio[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const s of studios.splice(0)) await s.close()
})

const yaml = (path: string) => `specVersion: 1
name: lifecycle
version: 1.0.0
secrets: [API_KEY]
defaults: { http: { allowInsecureHttp: true, timeoutMs: 2000 } }
tools:
  - name: keyed
    description: Sends the key and q
    input: { type: object, properties: { q: { type: string } } }
    http:
      url: http://bound.test:${upstream.port}${path}
      query: { q: "{{input.q}}" }
      headers: { X-Key: "{{secrets.API_KEY}}" }
    output: { select: "@" }
`

async function setup() {
  const s = apiStudio()
  studios.push(s)
  await s.addUser("admin@example.test", "admin")
  const admin = await s.signIn("admin@example.test")
  const created = await s.request("POST", "/api/servers", {
    ...admin,
    body: { slug: "lc", name: "l" },
  })
  const id = (created.json.server as { id: string }).id
  const putSecret = (body: { value?: string; allowedHosts: string[] }) =>
    s.request("PUT", `/api/servers/${id}/secrets/API_KEY`, { ...admin, body })
  await putSecret({ value: V1, allowedHosts: [`bound.test:${upstream.port}`] })
  await s.request("PUT", `/api/servers/${id}/settings`, { ...admin, body: { logPayloads: true } })
  const save = async (path: string) => {
    const saved = await s.request("POST", `/api/servers/${id}/versions`, {
      ...admin,
      body: { yaml: yaml(path) },
    })
    return (saved.json.version as { id: string }).id
  }
  const logs = async () => (await s.request("GET", `/api/servers/${id}/logs`, admin)).text
  /** A browser playground client on one version. */
  const playground = async (vid: string) => {
    const grant = await s.request("POST", `/api/servers/${id}/versions/${vid}/playground`, {
      ...admin,
      body: {},
    })
    const transport = new StreamableHTTPClientTransport(new URL(`/s/${id}/mcp`, ORIGIN), {
      requestInit: { headers: { authorization: `Bearer ${String(grant.json.token)}` } },
      fetch: async (url, init) => {
        const request = new Request(url, init)
        const headers: Record<string, string> = {}
        request.headers.forEach((value, name) => {
          headers[name] = value
        })
        headers.host = "studio.test"
        headers.origin = ORIGIN
        const body = request.method === "GET" ? undefined : await request.text()
        const response = await s.request(request.method, new URL(request.url).pathname, {
          headers,
          ...(body ? { body } : {}),
        })
        return new Response(response.text, { status: response.status, headers: response.headers })
      },
    })
    const client = new Client(
      { name: "pg", version: "0" },
      { versionNegotiation: { mode: { pin: MODERN } } },
    )
    await client.connect(transport)
    cleanups.push(() => client.close())
    return client
  }
  return { s, admin, id, putSecret, save, logs, playground }
}

describe("call-log payloads", () => {
  it("redact a secret a playground client sends as an argument to a draft", async () => {
    const { save, logs, playground } = await setup()
    const vid = await save("/echo/draft")
    const client = await playground(vid)
    const text = resultText(await client.callTool({ name: "keyed", arguments: { q: V1 } }))
    expect(text).not.toContain(V1)
    const logged = await logs()
    expect(logged).toContain("[redacted]")
    expect(logged).not.toContain(V1)
    expect(logged).not.toContain(encodeURIComponent(V1))
  })

  it("keep both the old and the new value redacted after a rotation", async () => {
    const { s, id, admin, save, logs, putSecret } = await setup()
    const vid = await save("/echo/pub")
    await s.request("POST", `/api/servers/${id}/versions/${vid}/publish`, { ...admin, body: {} })
    const key = await s.request("POST", `/api/servers/${id}/keys`, {
      ...admin,
      body: { name: "k" },
    })
    const client = await gatewayClient(s, id, String(key.json.key), cleanups)
    await client.callTool({ name: "keyed", arguments: { q: "first" } })
    await putSecret({ value: V2, allowedHosts: [`bound.test:${upstream.port}`] })
    const after = resultText(await client.callTool({ name: "keyed", arguments: { q: V1 } }))
    expect(upstream.requests.at(-1)?.headers["x-key"]).toBe(V2)
    expect(after).not.toContain(V1)
    expect(after).not.toContain(V2)
    await client.callTool({ name: "keyed", arguments: { q: V2 } })
    const logged = await logs()
    expect(logged).not.toContain(V1)
    expect(logged).not.toContain(V2)
  })

  it("never leave part of a secret behind where a payload is cut", async () => {
    const { save, logs, playground } = await setup()
    const vid = await save("/echo/cut")
    const client = await playground(vid)
    // Place the value across the 4 KiB cut of the logged arguments.
    for (const offset of [4080, 4085, 4090, 4094]) {
      await client.callTool({ name: "keyed", arguments: { q: `${"x".repeat(offset)}${V1}` } })
    }
    const logged = await logs()
    for (let n = 8; n <= V1.length; n++) expect(logged).not.toContain(V1.slice(0, n))
  })
})

describe("secret lifecycle with a loaded playground draft", () => {
  it("applies a narrowed binding at the draft's next call, before anything is sent", async () => {
    const { save, putSecret, playground } = await setup()
    const vid = await save("/echo/narrow-draft")
    const client = await playground(vid)
    await client.callTool({ name: "keyed", arguments: { q: "a" } })
    const sent = upstream.requests.length
    await putSecret({ allowedHosts: ["elsewhere.test"] })
    const text = resultText(await client.callTool({ name: "keyed", arguments: { q: "b" } }))
    expect(text).toMatch(/not configured/)
    expect(upstream.requests.length).toBe(sent)
  })

  it("fails a draft's calls without sending once the secret is deleted", async () => {
    const { s, id, admin, save, playground } = await setup()
    const vid = await save("/echo/deleted-draft")
    const client = await playground(vid)
    await client.callTool({ name: "keyed", arguments: { q: "a" } })
    const sent = upstream.requests.length
    const removed = await s.request("DELETE", `/api/servers/${id}/secrets/API_KEY`, {
      ...admin,
      body: {},
    })
    expect(removed.status).toBe(200) // not used by a published version
    const text = resultText(await client.callTool({ name: "keyed", arguments: { q: "b" } }))
    expect(text).toMatch(/not configured/)
    expect(upstream.requests.length).toBe(sent)
  })
})
