// Independent review: a secret's host:port binding cannot be bypassed through redirects to another
// port, another spelling of the host, or an IP form of it (T1).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type ApiStudio, apiStudio, gatewayClient } from "../api-helpers.js"
import { resultText, startUpstream, type Upstream } from "../helpers.js"

const SECRET = "sk-binding-review-0123456789"

let bound: Upstream
let other: Upstream
beforeAll(async () => {
  bound = await startUpstream()
  other = await startUpstream()
})
afterAll(async () => {
  await bound.close()
  await other.close()
})

const studios: ApiStudio[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const s of studios.splice(0)) await s.close()
})

/** The member's spec: the secret goes in the path to the bound host, which redirects to `to`. */
const yaml = (to: string) => `specVersion: 1
name: redirects
version: 1.0.0
secrets: [API_KEY]
defaults: { http: { allowInsecureHttp: true, timeoutMs: 2000, followRedirects: 3 } }
tools:
  - name: hop
    description: Redirects
    http:
      url: "http://bound.test:${bound.port}/redirect/{{secrets.API_KEY}}?to=${encodeURIComponent(to)}"
    output: { select: "@" }
`

async function call(to: string) {
  const s = apiStudio()
  studios.push(s)
  await s.addUser("admin@example.test", "admin")
  const admin = await s.signIn("admin@example.test")
  const created = await s.request("POST", "/api/servers", {
    ...admin,
    body: { slug: "r", name: "r" },
  })
  const id = (created.json.server as { id: string }).id
  await s.request("PUT", `/api/servers/${id}/secrets/API_KEY`, {
    ...admin,
    body: { value: SECRET, allowedHosts: [`bound.test:${bound.port}`] },
  })
  const saved = await s.request("POST", `/api/servers/${id}/versions`, {
    ...admin,
    body: { yaml: yaml(to) },
  })
  const vid = (saved.json.version as { id: string }).id
  const published = await s.request("POST", `/api/servers/${id}/versions/${vid}/publish`, {
    ...admin,
    body: {},
  })
  expect(published.status, published.text).toBe(200)
  const key = await s.request("POST", `/api/servers/${id}/keys`, { ...admin, body: { name: "k" } })
  const client = await gatewayClient(s, id, String(key.json.key), cleanups)
  return resultText(await client.callTool({ name: "hop", arguments: {} }))
}

describe("redirects never carry a bound secret off its host:port", () => {
  const before = () =>
    other.requests.length + bound.requests.filter((r) => r.path === "/steal").length

  it.each([
    ["another port of the bound host", () => `http://bound.test:${other.port}/steal?k=${SECRET}`],
    [
      "the bound host's address instead of its name",
      () => `http://127.0.0.1:${bound.port}/steal?k=${SECRET}`,
    ],
    [
      "the bound host with a trailing dot",
      () => `http://bound.test.:${bound.port}/steal?k=${SECRET}`,
    ],
    ["a subdomain of the bound host", () => `http://x.bound.test:${bound.port}/steal?k=${SECRET}`],
    ["a decimal IP form", () => `http://2130706433:${bound.port}/steal?k=${SECRET}`],
    ["the same host on https and port 443", () => `https://bound.test/steal?k=${SECRET}`],
  ])("%s", async (_label, target) => {
    const start = before()
    const text = await call(target())
    expect(text).not.toContain(SECRET)
    expect(before()).toBe(start)
  })

  it("still follows a redirect inside the bound host:port (baseline)", async () => {
    const text = await call(`http://BOUND.test:${bound.port}/landing`)
    expect(text).toContain("/landing")
    expect(text).not.toContain(SECRET)
  })
})
