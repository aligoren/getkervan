// Security review (release, gateway + spec-runtime): checks that held up, kept as regression
// tests.
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { gzipSync } from "node:zlib"
import { createApp, silentLogger } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"
import type { Client } from "@modelcontextprotocol/client"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { applySpec, loadSpec, type SecretSource, SpecLoadError } from "../../src/index.js"

const SECRET = "sk-review-gw-0123456789"

interface Seen {
  url: string
  headers: IncomingMessage["headers"]
  body: string
}
const seen: Seen[] = []
let server: Server
let base: string
beforeAll(async () => {
  server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    seen.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString() })
    const path = new URL(req.url ?? "/", "http://x").pathname
    if (path === "/drip") {
      // Headers at once, then one byte every 100 ms, forever.
      res.writeHead(200, { "content-type": "application/json" })
      res.write("[")
      const timer = setInterval(() => res.write(" "), 100)
      res.on("close", () => clearInterval(timer))
      return
    }
    if (path === "/double-gzip") {
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip, gzip" })
      return res.end(gzipSync(gzipSync('{"a":1}')))
    }
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ url: req.url, note: req.headers["x-note"] ?? null }))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }),
)

const clients: Client[] = []
afterEach(async () => {
  seen.length = 0
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

const secrets: SecretSource = { get: (name) => (name === "API_KEY" ? SECRET : undefined) }
const network = { allowPrivate: ["127.0.0.1/32"] }

const specOf = (tool: string) => `specVersion: 1
name: ok
version: 0.0.0
secrets: [API_KEY]
defaults: { http: { allowInsecureHttp: true, timeoutMs: 300 } }
tools:
${tool.replaceAll("BASE", base)}`

async function callTool(tool: string, args: Record<string, unknown> = {}) {
  const loaded = await loadSpec(specOf(tool), { secrets, network, allowSecretsOverHttp: true })
  const app = createApp({ name: "ok", version: "0.0.0", logger: silentLogger })
  applySpec(app.registry, loaded)
  const client = await createTestClient(app)
  clients.push(client)
  const result = (await client.callTool({ name: "t", arguments: args })) as {
    content: { text?: string }[]
    isError?: boolean
  }
  return { text: result.content.map((b) => b.text ?? "").join(""), isError: result.isError }
}

const inputTool = (http: string) => `
  - name: t
    description: t
    input: { type: object, properties: { v: { type: string } } }
    http:
${http}
    output: { select: "@" }`

describe("review-gw (ok): template values are data, never templates", () => {
  it("sends an input that looks like a secret reference literally, in every location", async () => {
    const ref = "{{secrets.API_KEY}}"
    await callTool(
      inputTool(`      method: POST
      url: BASE/items/{{input.v}}
      query: { q: "{{input.v}}" }
      headers: { X-Note: "{{input.v}}", X-Key: "{{secrets.API_KEY}}" }
      body: { v: "{{input.v}}", s: "x {{input.v}}" }`),
      { v: ref },
    )
    expect(seen).toHaveLength(1)
    const [request] = seen
    const everything = JSON.stringify({ ...request, headers: { ...request?.headers, "x-key": "" } })
    expect(everything).not.toContain(SECRET)
    expect(request?.headers["x-note"]).toBe(ref)
  })

  it("does not let an encoded dot segment in input climb the path", async () => {
    await callTool(inputTool("      url: BASE/a/b/{{input.v}}"), { v: "%2e%2e" })
    expect(seen[0]?.url).toBe("/a/b/%252e%252e")
  })

  it("refuses CR/LF in a header value from input, and does not echo the value", async () => {
    const { text, isError } = await callTool(
      inputTool(`      url: BASE/h
      headers: { X-Note: "{{input.v}}" }`),
      { v: "a\r\nX-Injected: 1" },
    )
    expect(isError).toBe(true)
    expect(text).not.toContain("X-Injected")
    expect(seen).toHaveLength(0)
  })

  it("cannot reach the host through a template written right after it", async () => {
    await expect(
      loadSpec(specOf(inputTool("      url: BASE{{input.v}}")), { secrets, network }),
    ).rejects.toThrow(SpecLoadError)
  })
})

describe("review-gw (ok): response limits", () => {
  it("cuts a body that drips forever at the tool's timeout, not the core's", async () => {
    const started = performance.now()
    const { text, isError } = await callTool(inputTool("      url: BASE/drip"))
    const elapsed = performance.now() - started
    expect(isError).toBe(true)
    expect(text).toMatch(/timed out/)
    expect(elapsed).toBeLessThan(3_000)
  })

  it("refuses a stacked content encoding instead of decoding one layer", async () => {
    const { text, isError } = await callTool(inputTool("      url: BASE/double-gzip"))
    expect(isError).toBe(true)
    expect(text).toMatch(/unsupported encoding/)
  })
})
