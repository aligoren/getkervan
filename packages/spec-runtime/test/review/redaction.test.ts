// Security review (phase 4a): secret redaction in tool results.
//
// The threat model (T2) says tool results are redacted by the vault in raw, URL-, form- and
// JSON-encoded forms. The spec author (a semi-trusted member) also writes the `select`
// expression and `maxOutputChars`, and both run on the upstream's data BEFORE the redaction
// middleware sees it. When a bound upstream reflects the secret (a whoami endpoint, an error
// message that echoes the key, a pagination link carrying `?api_key=`), the author can reshape
// the value so that no needle matches any more. Every test here asserts the secure behavior.
import { createApp, silentLogger } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"
import type { Client } from "@modelcontextprotocol/client"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { applySpec, loadSpec, type NetworkPolicy, type SecretSource } from "../../src/index.js"
import { startUpstream, type Upstream } from "../upstream.js"

const SECRET = "sk-bound-0123456789"
let upstream: Upstream
let port: string
beforeAll(async () => {
  upstream = await startUpstream()
  port = new URL(upstream.url).port
})
afterAll(() => upstream.close())

const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

/** Every name resolves to the local test API. */
const network: NetworkPolicy = {
  allowPrivate: ["127.0.0.1/32"],
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
}

/** Answers only for bound.test, like Studio's store. */
const source: SecretSource = {
  get: (name, context) =>
    name === "API_KEY" && context?.host === `bound.test:${port}` ? SECRET : undefined,
}

/** One tool that sends the key to the bound host's /reflect endpoint (it echoes X-Key back). */
const reflectSpec = (output: string) => `specVersion: 1
name: review
version: 0.0.0
secrets: [{ name: API_KEY, hosts: ['bound.test:${port}'] }]
defaults: { http: { allowInsecureHttp: true, timeoutMs: 2000 } }
tools:
  - name: call
    description: Sends the key to the bound host
    http:
      url: http://bound.test:${port}/reflect
      headers: { X-Key: "{{secrets.API_KEY}}" }
    output: ${output}`

async function call(output: string): Promise<string> {
  // The local test API speaks http; secrets over http need the development opt-in.
  const loaded = await loadSpec(reflectSpec(output), {
    secrets: source,
    network,
    allowSecretsOverHttp: true,
  })
  const app = createApp({ name: "review", version: "0.0.0", logger: silentLogger })
  applySpec(app.registry, loaded)
  const client = await createTestClient(app)
  clients.push(client)
  const result = await client.callTool({ name: "call", arguments: {} })
  return (result as { content: { text?: string }[] }).content.map((b) => b.text ?? "").join("")
}

const reversed = [...SECRET].reverse().join("")

describe("review: redaction survives the spec author's own output shaping", () => {
  it("baseline: the plain reflected value is redacted", async () => {
    const text = await call('{ select: "raw" }')
    expect(text).not.toContain(SECRET)
  })

  it.each([
    ["upper-casing", "upper(raw)", SECRET.toUpperCase()],
    ["reversing with a function", "reverse(raw)", reversed],
    ["reversing with a slice", "raw[::-1]", reversed],
    ["replacing a character", 'replace(raw, `"-"`, `"_"`)', SECRET.replaceAll("-", "_")],
  ])("does not return the secret reshaped by select (%s)", async (_name, select, leaked) => {
    const text = await call(`{ select: '${select}' }`)
    expect(text).not.toContain(leaked)
  })

  it("does not return the secret split into pieces that rejoin to it", async () => {
    const text = await call("{ select: '[raw[0:9], raw[9:]]' }")
    const pieces = JSON.parse(text) as unknown
    expect(Array.isArray(pieces) ? pieces.join("") : text).not.toBe(SECRET)
  })

  it("does not answer yes/no questions about the secret (a character-by-character oracle)", async () => {
    // Each call reveals one bit; a few hundred calls recover the whole value.
    const text = await call("{ select: 'starts_with(raw, `\"sk-bound-0\"`)' }")
    expect(text).not.toBe("true")
  })

  it("does not reveal the secret's length", async () => {
    const text = await call("{ select: 'length(raw)' }")
    expect(text).not.toBe(String(SECRET.length))
  })

  it("does not leak a prefix of the secret when maxOutputChars cuts through it", async () => {
    // The body starts with {"raw":"<secret>"; cutting 12 characters into the value leaves a
    // fragment that no longer matches the whole-value needle.
    const keep = '{"raw":"'.length + 12
    const text = await call(`{ raw: true, maxOutputChars: ${keep} }`)
    expect(text).not.toContain(SECRET.slice(0, 12))
  })
})
