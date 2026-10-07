// Security review (release): a secret the upstream reflects as a JSON NUMBER. Upstream data is
// redacted before the spec's `select` runs (T2), numbers included: as the upstream wrote them, so
// a long numeric secret is caught even where parsing would round it. Otherwise a spec author could
// shift or bisect the value with JMESPath arithmetic and comparisons, and an output schema would
// return it as structured content.
import { createApp, silentLogger } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"
import type { Client } from "@modelcontextprotocol/client"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { applySpec, loadSpec, type NetworkPolicy, type SecretSource } from "../../src/index.js"
import { startUpstream, type Upstream } from "../upstream.js"

const NUMERIC = "820461937520"

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

const network: NetworkPolicy = {
  allowPrivate: ["127.0.0.1/32"],
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
}

const source: SecretSource = {
  get: (name, context) =>
    name === "API_KEY" && context?.host === `bound.test:${port}` ? NUMERIC : undefined,
}

// /reflect-escaped?number=1 answers {"number":<X-Key>, ...}: the key as a JSON number.
const specWith = (output: string) => `specVersion: 1
name: review
version: 0.0.0
secrets: [{ name: API_KEY, hosts: ['bound.test:${port}'] }]
defaults: { http: { allowInsecureHttp: true, timeoutMs: 2000 } }
tools:
  - name: call
    description: Sends the key to the bound host
    http:
      url: http://bound.test:${port}/reflect-escaped?number=1
      headers: { X-Key: "{{secrets.API_KEY}}" }
    output: ${output}`

async function call(output: string) {
  const loaded = await loadSpec(specWith(output), {
    secrets: source,
    network,
    allowSecretsOverHttp: true,
  })
  const app = createApp({ name: "review", version: "0.0.0", logger: silentLogger })
  applySpec(app.registry, loaded)
  const client = await createTestClient(app)
  clients.push(client)
  const result = (await client.callTool({ name: "call", arguments: {} })) as {
    content: { text?: string }[]
    structuredContent?: unknown
  }
  return {
    text: result.content.map((b) => b.text ?? "").join(""),
    structured: JSON.stringify(result.structuredContent ?? null),
  }
}

describe("review-gw: a secret reflected as a JSON number", () => {
  it("is not returned as structured output when the tool has an output schema", async () => {
    const result = await call("{ select: 'number', schema: { type: number } }")
    expect(result.text).not.toContain(NUMERIC)
    expect(result.structured).not.toContain(NUMERIC)
  })

  it("cannot be reshaped by select arithmetic (secret + 1)", async () => {
    const { text } = await call("{ select: 'number + `1`' }")
    // A result of secret + 1 gives the secret away: subtract one.
    expect(Number(text) - 1).not.toBe(Number(NUMERIC))
  })

  it("cannot be bisected with a comparison (a yes/no oracle)", async () => {
    const below = await call("{ select: 'number > `820461937519`' }")
    const above = await call("{ select: 'number > `820461937520`' }")
    // Two answers that differ pin the value down exactly.
    expect([below.text, above.text]).not.toEqual(["true", "false"])
  })
})
