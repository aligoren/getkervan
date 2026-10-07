// Security review (release, gateway): a member cannot recover an admin-set secret through the
// playground when the bound upstream reflects it as a JSON number. Upstream data is redacted
// before `select` (T2), numbers included, and neither results nor the call log hold the value.
//
// Roles: the admin sets the secret (members cannot read secrets); the member only writes a draft
// and calls it in the playground. Nothing is published and no API key is involved.
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type ApiStudio, apiStudio, gatewayClient } from "../api-helpers.js"

const NUMERIC = "820461937520"

/** A bound API whose "whoami" answers with the account number it was given, as a number. */
let upstream: Server
let port: number
beforeAll(async () => {
  upstream = createServer((req, res) => {
    const key = String(req.headers["x-account"] ?? "0")
    res.writeHead(200, { "content-type": "application/json" })
    res.end(`{"account":${/^\d+$/.test(key) ? key : 0},"plan":"pro"}`)
  })
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  port = (upstream.address() as AddressInfo).port
})
afterAll(
  () =>
    new Promise<void>((resolve) => {
      upstream.closeAllConnections()
      upstream.close(() => resolve())
    }),
)

const studios: ApiStudio[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const s of studios.splice(0)) await s.close()
})

const yaml = (output: string) => `specVersion: 1
name: numeric-review
version: 1.0.0
secrets: [ACCOUNT]
defaults: { http: { allowInsecureHttp: true, timeoutMs: 2000 } }
tools:
  - name: whoami
    description: Who am I
    http:
      url: http://bound.test:${port}/whoami
      headers: { X-Account: "{{secrets.ACCOUNT}}" }
    output: ${output}
`

async function setup() {
  const s = apiStudio()
  studios.push(s)
  await s.addUser("admin@example.test", "admin")
  await s.addUser("member@example.test", "member")
  const admin = await s.signIn("admin@example.test")
  const member = await s.signIn("member@example.test", undefined, "203.0.113.2")
  const created = await s.request("POST", "/api/servers", {
    ...admin,
    body: { slug: "acct", name: "Account" },
  })
  const id = (created.json.server as { id: string }).id
  const put = await s.request("PUT", `/api/servers/${id}/secrets/ACCOUNT`, {
    ...admin,
    body: { value: NUMERIC, allowedHosts: [`bound.test:${port}`] },
  })
  expect(put.status, put.text).toBe(200)
  await s.request("PUT", `/api/servers/${id}/settings`, { ...admin, body: { logPayloads: true } })
  return { s, admin, member, id }
}

/** The member saves a draft with `output` and calls it in the playground. */
async function memberCall(
  ctx: Awaited<ReturnType<typeof setup>>,
  output: string,
): Promise<{ text: string; structured: string }> {
  const { s, member, id } = ctx
  const saved = await s.request("POST", `/api/servers/${id}/versions`, {
    ...member,
    body: { yaml: yaml(output) },
  })
  expect(saved.status, saved.text).toBe(201)
  const vid = (saved.json.version as { id: string }).id
  const grant = await s.request("POST", `/api/servers/${id}/versions/${vid}/playground`, {
    ...member,
    body: {},
  })
  expect(grant.status, grant.text).toBe(200)
  const client = await gatewayClient(s, id, String(grant.json.token), cleanups)
  const result = (await client.callTool({ name: "whoami", arguments: {} })) as {
    content: { text?: string }[]
    structuredContent?: unknown
  }
  return {
    text: result.content.map((b) => b.text ?? "").join(""),
    structured: JSON.stringify(result.structuredContent ?? null),
  }
}

describe("review-gw: a numeric secret in the playground", () => {
  it("baseline: the member cannot read the secret through the management API", async () => {
    const ctx = await setup()
    const listed = await ctx.s.request("GET", `/api/servers/${ctx.id}/secrets`, ctx.member)
    expect(listed.text).not.toContain(NUMERIC)
  })

  it("is not given back as structured output, nor kept in the call log", async () => {
    const ctx = await setup()
    const { text, structured } = await memberCall(
      ctx,
      "{ select: '{account: account}', schema: { type: object, properties: { account: { type: number } } } }",
    )
    expect.soft(text, "text content").not.toContain(NUMERIC)
    expect.soft(structured, "structuredContent").not.toContain(NUMERIC)
    const logs = await ctx.s.request("GET", `/api/servers/${ctx.id}/logs`, ctx.admin)
    expect(logs.status).toBe(200)
    expect.soft(logs.text, "call log").not.toContain(NUMERIC)
  })

  it("cannot be recovered by the member's select arithmetic", async () => {
    const ctx = await setup()
    // Shift by a constant: the result no longer matches the value, so redaction misses it.
    const { text } = await memberCall(ctx, "{ select: 'account - `7`' }")
    expect(Number(text) + 7).not.toBe(Number(NUMERIC))
  })
})
