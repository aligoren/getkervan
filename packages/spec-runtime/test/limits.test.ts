import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { createApp } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  applySpec,
  checkSchemaLimits,
  loadSpec,
  SCHEMA_LIMITS,
  SpecLoadError,
} from "../src/index.js"

const nested = (depth: number): Record<string, unknown> =>
  depth === 0 ? { type: "string" } : { type: "object", properties: { a: nested(depth - 1) } }

describe("JSON Schema limits", () => {
  it("accepts an ordinary schema with local references", () => {
    expect(
      checkSchemaLimits({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        $defs: { id: { type: "string", pattern: "^[a-z]+$" } },
        properties: { id: { $ref: "#/$defs/id" } },
      }),
    ).toEqual([])
  })

  it.each([
    ["a remote $ref", { $ref: "https://evil.example/schema.json" }, /Only local \$ref/],
    ["a relative file $ref", { $ref: "other.json#/x" }, /Only local \$ref/],
    ["a non-string $ref", { $ref: 42 }, /Only local \$ref/],
    ["$id", { $id: "https://evil.example/s" }, /"\$id" is not allowed/],
    ["$dynamicRef", { $dynamicRef: "#meta" }, /"\$dynamicRef" is not allowed/],
    ["$recursiveRef", { $recursiveRef: "#" }, /"\$recursiveRef" is not allowed/],
    ["another dialect", { $schema: "http://json-schema.org/draft-07/schema#" }, /2020-12/],
    ["deep nesting", nested(40), /nested deeper than 32/],
    [
      "too many nodes",
      {
        type: "object",
        properties: Object.fromEntries(
          Array.from({ length: 2100 }, (_, i) => [`p${i}`, { type: "string" }]),
        ),
      },
      /more than 2000 nodes/,
    ],
    [
      "too many combinators",
      { allOf: Array.from({ length: 70 }, () => ({ anyOf: [{ type: "string" }] })) },
      /anyOf\/oneOf\/allOf/,
    ],
    ["a huge schema", { description: "x".repeat(70_000) }, /larger than 65536 bytes/],
    [
      "a long pattern",
      { type: "string", pattern: `^${"a".repeat(600)}$` },
      /pattern is longer than 512/,
    ],
    [
      "a long patternProperties key",
      { patternProperties: { ["a".repeat(600)]: {} } },
      /pattern is longer than 512/,
    ],
  ])("rejects %s", (_label, schema, pattern) => {
    expect(checkSchemaLimits(schema).join("\n")).toMatch(pattern)
  })

  it("fails closed on values that are not plain JSON", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(checkSchemaLimits(cyclic)).toEqual(["The schema is not plain JSON."])
  })

  it("applies to input and output schemas in a spec", async () => {
    const text = `specVersion: 1
name: s
version: 0.0.0
tools:
  - name: t
    description: d
    input: { type: object, properties: { a: { $ref: "https://evil.example/x.json" } } }
    http: { url: https://api.example.com }
    output: { select: "@", schema: { $id: "https://evil.example/out" } }
`
    const error = await loadSpec(text, { secrets: { get: () => undefined } }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(SpecLoadError)
    expect((error as Error).message).toMatch(/tools\[0\]\.input: Only local \$ref/)
    expect((error as Error).message).toMatch(/tools\[0\]\.output\.schema: "\$id" is not allowed/)
  })

  it("exposes its limits", () => {
    expect(SCHEMA_LIMITS).toMatchObject({ maxDepth: 32, maxNodes: 2000, maxBytes: 65536 })
  })
})

describe("rate limits", () => {
  let server: Server
  let base = ""
  beforeAll(async () => {
    server = createServer((req, res) => {
      const delay = req.url?.startsWith("/slow") ? 300 : 0
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" })
        res.end('{"ok":true}')
      }, delay)
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  async function client(rateLimit: string, path = "/") {
    const loaded = await loadSpec(
      `specVersion: 1
name: rl
version: 0.0.0
defaults: { http: { allowInsecureHttp: true } }
tools:
  - { name: t, description: d, rateLimit: ${rateLimit}, http: { url: "${base}${path}" }, output: { select: ok } }
`,
      { secrets: { get: () => undefined }, network: { allowPrivate: ["127.0.0.1/32"] } },
    )
    const app = createApp({ name: "rl", version: "0" })
    applySpec(app.registry, loaded)
    return createTestClient(app)
  }

  it("stops calls over the per-minute limit", async () => {
    const c = await client("{ perMinute: 2 }")
    const results = []
    for (let i = 0; i < 3; i++) results.push(await c.callTool({ name: "t", arguments: {} }))
    expect(results.map((r) => r.isError ?? false)).toEqual([false, false, true])
    expect(JSON.stringify(results[2])).toMatch(
      /Rate limit reached for tool \\"t\\"; try again in \d+ s/,
    )
    await c.close()
  })

  it("stops calls over the concurrency limit", async () => {
    const c = await client("{ concurrency: 1 }", "/slow")
    const [first, second] = await Promise.all([
      c.callTool({ name: "t", arguments: {} }),
      c.callTool({ name: "t", arguments: {} }),
    ])
    expect([first.isError ?? false, second.isError ?? false].sort()).toEqual([false, true])
    await c.close()
  })

  it("is on by default", async () => {
    const loaded = await loadSpec(
      `specVersion: 1
name: d
version: 0.0.0
tools: [{ name: t, description: d, http: { url: "https://api.example.com" }, output: { select: "@" } }]
`,
      { secrets: { get: () => undefined } },
    )
    expect(loaded.tools).toHaveLength(1)
    const { HTTP_DEFAULTS } = await import("../src/index.js")
    expect(HTTP_DEFAULTS.rateLimit).toEqual({ perMinute: 60, concurrency: 10 })
  })
})
