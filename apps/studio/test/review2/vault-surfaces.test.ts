// Independent review: the vault is write-only (T2, T14, T16). No API response, error, audit row,
// export, call log or database row may contain a secret value, in any of the encodings Studio
// itself claims to cover.
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { type ApiStudio, apiStudio, gatewayClient, TEST_KEYS } from "../api-helpers.js"
import { resultText } from "../helpers.js"

// A realistic key shape: base64 keys often contain "/" and "+".
const SECRET = "sk/live+Abc/0123456789xyz"

/**
 * A bound upstream that echoes the X-Key header in JSON the way PHP's json_encode (and several
 * Java encoders) write it: "/" escaped as "\/". Valid JSON, same value.
 */
let upstream: Server
let port: number
beforeAll(async () => {
  upstream = createServer((req, res) => {
    const key = String(req.headers["x-key"] ?? "")
    res.writeHead(200, { "content-type": "application/json" })
    res.end(`{"key":"${key.replaceAll("/", "\\/")}"}`)
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
name: vault-review
version: 1.0.0
secrets: [API_KEY]
defaults: { http: { allowInsecureHttp: true, timeoutMs: 2000 } }
tools:
  - name: echo_key
    description: Sends the key; the API echoes it
    http:
      url: http://bound.test:${port}/echo
      headers: { X-Key: "{{secrets.API_KEY}}" }
    output: ${output}
`

async function setup(output: string) {
  const s = apiStudio()
  studios.push(s)
  await s.addUser("admin@example.test", "admin")
  const admin = await s.signIn("admin@example.test")
  const created = await s.request("POST", "/api/servers", {
    ...admin,
    body: { slug: "vault", name: "v" },
  })
  const id = (created.json.server as { id: string }).id
  const put = await s.request("PUT", `/api/servers/${id}/secrets/API_KEY`, {
    ...admin,
    body: { value: SECRET, allowedHosts: [`bound.test:${port}`] },
  })
  expect(put.status, put.text).toBe(200)
  await s.request("PUT", `/api/servers/${id}/settings`, { ...admin, body: { logPayloads: true } })
  const saved = await s.request("POST", `/api/servers/${id}/versions`, {
    ...admin,
    body: { yaml: yaml(output) },
  })
  const vid = (saved.json.version as { id: string }).id
  const published = await s.request("POST", `/api/servers/${id}/versions/${vid}/publish`, {
    ...admin,
    body: {},
  })
  expect(published.status, published.text).toBe(200)
  const key = await s.request("POST", `/api/servers/${id}/keys`, { ...admin, body: { name: "k" } })
  return { s, admin, id, key: String(key.json.key) }
}

/** The forms of the value a reader could recognize. */
const forms = (value: string) => [
  value,
  encodeURIComponent(value),
  JSON.stringify(value).slice(1, -1),
  value.replaceAll("/", "\\/"),
]

describe("secret values in tool results and call logs", () => {
  it("are redacted from a selected JSON result (baseline)", async () => {
    const { s, admin, id, key } = await setup('{ select: "@" }')
    const client = await gatewayClient(s, id, key, cleanups)
    const text = resultText(await client.callTool({ name: "echo_key", arguments: {} }))
    for (const form of forms(SECRET)) expect(text).not.toContain(form)
    const logs = await s.request("GET", `/api/servers/${id}/logs`, admin)
    for (const form of forms(SECRET)) expect(logs.text).not.toContain(form)
  })

  // T2: results are redacted "in raw, URL-encoded, form-encoded and JSON-escaped forms". JSON has
  // more than one escaped form of the same string; with `raw: true` the upstream's own escaping
  // reaches the model, the playground and the call log.
  it("are redacted from a raw JSON result, whatever escaping the upstream's encoder uses", async () => {
    const { s, admin, id, key } = await setup("{ raw: true }")
    const client = await gatewayClient(s, id, key, cleanups)
    const text = resultText(await client.callTool({ name: "echo_key", arguments: {} }))
    expect(text).toContain("[redacted]")
    for (const form of forms(SECRET)) expect(text, `result contains ${form}`).not.toContain(form)
    const logs = await s.request("GET", `/api/servers/${id}/logs`, admin)
    for (const form of forms(SECRET)) expect(logs.text, `log contains ${form}`).not.toContain(form)
  })
})

describe("secret values in the management API", () => {
  it("are never echoed by failed writes", async () => {
    const { s, admin, id } = await setup('{ select: "@" }')
    const value = "sk-never-echo-this-value-42"
    const attempts = [
      { value, allowedHosts: ["https://bad.test/path"] },
      { value, allowedHosts: [] },
      { value, allowedHosts: ["*.example.test"] },
      { value: `${value}\u0000`, allowedHosts: ["ok.test"] },
    ]
    for (const body of attempts) {
      const response = await s.request("PUT", `/api/servers/${id}/secrets/API_KEY`, {
        ...admin,
        body,
      })
      expect(response.text).not.toContain(value)
    }
    const short = await s.request("PUT", `/api/servers/${id}/secrets/SHORT`, {
      ...admin,
      body: { value: "abc1234", allowedHosts: ["ok.test"] },
    })
    expect(short.status).toBe(400)
    expect(short.text).not.toContain("abc1234")
    const badName = await s.request("PUT", `/api/servers/${id}/secrets/bad-name`, {
      ...admin,
      body: { value, allowedHosts: ["ok.test"] },
    })
    expect(badName.status).toBe(400)
    expect(badName.text).not.toContain(value)
    // None of them reached the audit log or the database in clear.
    const audit = await s.request("GET", "/api/audit", admin)
    expect(audit.text).not.toContain(value)
    const dump = JSON.stringify(
      s.database.sqlite
        .prepare("SELECT * FROM secrets")
        .all()
        .map((row) => JSON.stringify(row)),
    )
    expect(dump).not.toContain(value)
    expect(dump).not.toContain(SECRET)
  })

  it("never puts the master key in the database", async () => {
    const { s } = await setup('{ select: "@" }')
    const key = TEST_KEYS.current().key
    const tables = s.database.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[]
    const dump = tables
      .map(({ name }) => JSON.stringify(s.database.sqlite.prepare(`SELECT * FROM "${name}"`).all()))
      .join("\n")
    for (const form of [key.toString("base64"), key.toString("hex"), key.toString("base64url")]) {
      expect(dump).not.toContain(form)
    }
  })
})
