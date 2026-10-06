import { createApp, type Logger } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"
import type { Client } from "@modelcontextprotocol/client"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { applySpec, httpTool, loadSpec, type SecretSource } from "../src/index.js"
import { startUpstream, type Upstream } from "./upstream.js"

const SECRET = "sk-live-Abc+/= 123&x"
let upstream: Upstream
beforeAll(async () => {
  upstream = await startUpstream()
})
afterAll(() => upstream.close())

const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = []
  const record = (message: string, data?: unknown) => {
    lines.push(`${message} ${data === undefined ? "" : JSON.stringify(data)}`)
  }
  return { lines, debug: record, info: record, warn: record, error: record }
}

const secrets: SecretSource = { get: (name) => (name === "API_KEY" ? SECRET : undefined) }

async function serve(tools: string, era: "modern" | "legacy" = "modern", head = "") {
  const text = `specVersion: 1
name: executor-test
version: 0.0.0
secrets: [API_KEY]
defaults: { http: { allowInsecureHttp: true, timeoutMs: 1000, maxResponseBytes: 100000 } }
${head}
tools:
${tools.replaceAll("BASE", upstream.url)}`
  const loaded = await loadSpec(text, { secrets })
  const logger = recordingLogger()
  const app = createApp({ name: "executor", version: "0.0.0", logger })
  applySpec(app.registry, loaded)
  const client = await createTestClient(app, { era })
  clients.push(client)
  return { client, logger }
}

const text = (result: unknown) =>
  (result as { content: { text?: string }[] }).content.map((block) => block.text ?? "").join("")

const echoTool = `
  - name: echo
    description: Echoes the request
    input:
      type: object
      properties:
        id: { type: string }
        tags: { type: array, items: { type: string } }
        note: { type: string }
        count: { type: integer }
        flag: { type: boolean }
    http:
      method: POST
      url: BASE/echo/items/{{input.id}}
      query: { tag: "{{input.tags}}", note: "{{input.note}}", fixed: "1" }
      headers: { X-Note: "{{input.note}}", X-Key: "{{secrets.API_KEY}}" }
      body:
        count: "{{input.count}}"
        flag: "{{input.flag}}"
        sentence: "note is {{input.note}}"
        nested: { list: ["{{input.id}}", 2] }
    output:
      select: "{method: method, path: path, rawPath: rawPath, query: query, note: headers.\\"x-note\\", body: body}"
`

describe.each(["modern", "legacy"] as const)("templating (%s era)", (era) => {
  it("renders path, query, headers and a typed JSON body", async () => {
    const { client } = await serve(echoTool, era)
    const result = await client.callTool({
      name: "echo",
      arguments: { id: "a b/c", tags: ["x", "y&z"], note: "hi", count: 3, flag: true },
    })
    expect(result.isError).toBeFalsy()
    const echoed = JSON.parse(text(result))
    expect(echoed).toMatchObject({
      method: "POST",
      path: "/echo/items/a%20b%2Fc",
      query: { tag: ["x", "y&z"], note: ["hi"], fixed: ["1"] },
      note: "hi",
      body: { count: 3, flag: true, sentence: "note is hi", nested: { list: ["a b/c", 2] } },
    })
  })

  it("keeps injection attempts as data", async () => {
    const { client } = await serve(echoTool, era)
    const attack = 'x", "admin": true, "y": "'
    const result = await client.callTool({ name: "echo", arguments: { id: "1", note: attack } })
    const echoed = JSON.parse(text(result))
    expect(echoed.body.sentence).toBe(`note is ${attack}`)
    expect(echoed.body).not.toHaveProperty("admin")
    expect(echoed.query.note).toEqual([attack])
  })
})

describe("template safety", () => {
  it.each([".", ".."])("rejects %j as a path value (traversal)", async (id) => {
    const { client } = await serve(echoTool)
    const before = upstream.requests.length
    const result = await client.callTool({ name: "echo", arguments: { id } })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(/not allowed in a URL path/)
    expect(upstream.requests.length).toBe(before)
  })

  it.each(["a\r\nX-Injected: 1", "a\nb", "a\u0000b"])(
    "rejects header injection %j without sending",
    async (note) => {
      const { client } = await serve(echoTool)
      const before = upstream.requests.length
      const result = await client.callTool({ name: "echo", arguments: { id: "1", note } })
      expect(result.isError).toBe(true)
      expect(text(result)).toMatch(/line break or control character/)
      expect(upstream.requests.length).toBe(before)
    },
  )

  it("leaves out optional query parameters that were not given", async () => {
    const { client } = await serve(echoTool)
    const result = await client.callTool({ name: "echo", arguments: { id: "1", note: "n" } })
    expect(JSON.parse(text(result)).query).toEqual({ note: ["n"], fixed: ["1"] })
  })
})

describe("output", () => {
  it("selects and reshapes with JMESPath", async () => {
    const { client } = await serve(`
  - name: names
    description: d
    http: { url: BASE/echo }
    output: { select: "nested.items[].{id: id, name: name}" }`)
    const result = await client.callTool({ name: "names", arguments: {} })
    expect(JSON.parse(text(result))).toEqual([
      { id: 1, name: "one" },
      { id: 2, name: "two" },
    ])
  })

  it("returns structured content when output.schema is set", async () => {
    const { client } = await serve(`
  - name: deep
    description: d
    http: { url: BASE/echo }
    output:
      select: "{b: nested.a.b}"
      schema: { type: object, properties: { b: { type: number } }, required: [b] }`)
    const result = await client.callTool({ name: "deep", arguments: {} })
    expect(result.structuredContent).toEqual({ b: 42 })
  })

  it("cuts long text output and refuses oversized structured output", async () => {
    const { client } = await serve(`
  - name: long
    description: d
    http: { url: BASE/big, maxResponseBytes: 1000000 }
    output: { select: data, maxOutputChars: 100 }
  - name: long_structured
    description: d
    http: { url: BASE/big, maxResponseBytes: 1000000 }
    output:
      select: "{data: data}"
      schema: { type: object }
      maxOutputChars: 100`)
    const cut = text(await client.callTool({ name: "long", arguments: {} }))
    expect(cut.length).toBeLessThan(200)
    expect(cut).toMatch(/\[truncated: \d+ more characters\]/)
    const refused = await client.callTool({ name: "long_structured", arguments: {} })
    expect(refused.isError).toBe(true)
    expect(text(refused)).toMatch(/Narrow output\.select/)
  })

  it("returns raw text only when asked, and only for text responses", async () => {
    const { client } = await serve(`
  - name: raw_text
    description: d
    http: { url: BASE/text }
    output: { raw: true, maxOutputChars: 10 }
  - name: raw_image
    description: d
    http: { url: BASE/image }
    output: { raw: true }`)
    expect(text(await client.callTool({ name: "raw_text", arguments: {} }))).toMatch(/^line 1\nzzz/)
    const image = await client.callTool({ name: "raw_image", arguments: {} })
    expect(text(image)).toBe(
      'Upstream returned content type "image/png"; raw output needs text or JSON.',
    )
  })
})

describe("limits", () => {
  const tools = `
  - { name: slow, description: d, http: { url: BASE/slow }, output: { select: "@" } }
  - { name: big, description: d, http: { url: BASE/big, maxResponseBytes: 1000 }, output: { select: "@" } }
  - { name: chunked, description: d, http: { url: BASE/chunked, maxResponseBytes: 1000 }, output: { select: "@" } }
  - { name: bomb, description: d, http: { url: BASE/bomb }, output: { select: "@" } }
  - { name: gzip, description: d, http: { url: BASE/gzip }, output: { select: "@" } }
  - { name: image, description: d, http: { url: BASE/image }, output: { select: "@" } }
  - { name: badjson, description: d, http: { url: BASE/badjson }, output: { select: "@" } }
  - { name: redirect, description: d, http: { url: BASE/redirect }, output: { select: "@" } }
  - { name: not_found, description: d, http: { url: BASE/status/404 }, output: { select: "@" } }
  - { name: server_error, description: d, http: { url: BASE/status/503 }, output: { select: "@" } }`

  it.each([
    ["slow", /timed out after 1000 ms/],
    ["big", /larger than 1000 bytes/],
    ["chunked", /larger than 1000 bytes/],
    ["bomb", /larger than 100000 bytes/],
    ["image", /content type "image\/png"; expected JSON/],
    ["badjson", /invalid JSON/],
    ["redirect", /redirected \(302\); redirects are not followed/],
    ["not_found", /^Upstream returned 404 Not Found\.$/],
    ["server_error", /^Upstream returned 503 Service Unavailable\.$/],
  ])("%s fails with a clear error", { timeout: 10_000 }, async (name, pattern) => {
    const { client } = await serve(tools)
    const result = await client.callTool({ name, arguments: {} })
    expect(result.isError).toBe(true)
    expect(text(result)).toMatch(pattern)
    expect(text(result)).not.toMatch(/Ignore previous instructions/)
  })

  it("decodes gzip responses", async () => {
    const { client } = await serve(tools)
    expect(JSON.parse(text(await client.callTool({ name: "gzip", arguments: {} })))).toEqual({
      zipped: true,
    })
  })

  it("does not follow redirects", async () => {
    const { client } = await serve(tools)
    const before = upstream.requests.filter((r) => r.path === "/echo/redirected").length
    await client.callTool({ name: "redirect", arguments: {} })
    expect(upstream.requests.filter((r) => r.path === "/echo/redirected").length).toBe(before)
  })
})

describe("secrets never leak", () => {
  const tools = `
  - name: reflect_ok
    description: d
    http:
      url: BASE/reflect
      headers: { X-Key: "{{secrets.API_KEY}}" }
      query: { key: "{{secrets.API_KEY}}" }
    output: { select: "@" }
  - name: reflect_raw
    description: d
    http: { url: BASE/reflect, headers: { X-Key: "{{secrets.API_KEY}}" } }
    output: { raw: true }
  - name: reflect_structured
    description: d
    http: { url: BASE/reflect, headers: { X-Key: "{{secrets.API_KEY}}" } }
    output: { select: "@", schema: { type: object } }
  - name: reflect_error
    description: d
    http: { url: "BASE/reflect/{{secrets.API_KEY}}?status=401", headers: { X-Key: "{{secrets.API_KEY}}" } }
    output: { select: "@" }`

  const forms = [
    SECRET,
    encodeURIComponent(SECRET),
    new URLSearchParams({ v: SECRET }).toString().slice(2),
    JSON.stringify(SECRET).slice(1, -1),
  ]

  it.each(["reflect_ok", "reflect_raw", "reflect_structured", "reflect_error"])(
    "%s: results, errors and logs hold no secret in any encoding",
    async (name) => {
      const { client, logger } = await serve(tools)
      const result = await client.callTool({ name, arguments: {} })
      const everything = JSON.stringify(result) + logger.lines.join("\n")
      for (const form of forms) expect(everything).not.toContain(form)
      if (name !== "reflect_error") expect(everything).toContain("[redacted]")
      // The request did carry the secret: redaction is on the way back, not by not sending it.
      expect(upstream.requests.at(-1)?.headers["x-key"]).toBe(SECRET)
    },
  )

  it("names a missing secret without failing the load", async () => {
    const loaded = await loadSpec(
      `specVersion: 1
name: s
version: 0.0.0
secrets: [OTHER_KEY]
tools:
  - { name: t, description: d, http: { url: "${upstream.url}/echo", allowInsecureHttp: true, headers: { X-Key: "{{secrets.OTHER_KEY}}" } }, output: { select: "@" } }`,
      { secrets: { get: () => undefined } },
    )
    const app = createApp({ name: "s", version: "0", logger: recordingLogger() })
    applySpec(app.registry, loaded)
    const client = await createTestClient(app)
    clients.push(client)
    const result = await client.callTool({ name: "t", arguments: {} })
    expect(text(result)).toBe("Secret OTHER_KEY is not configured.")
  })
})

describe("httpTool (code API)", () => {
  it("builds the same tool from an object", async () => {
    const [name, definition] = httpTool(
      {
        name: "code_echo",
        description: "d",
        input: { type: "object", properties: { id: { type: "string" } } },
        http: { url: `${upstream.url}/echo/{{input.id}}`, allowInsecureHttp: true },
        output: { select: "path" },
      },
      { secrets },
    )
    const app = createApp({ name: "code", version: "0" })
    if ("output" in definition && definition.output) app.tool(name, definition)
    else app.tool(name, definition)
    const client = await createTestClient(app)
    clients.push(client)
    expect(text(await client.callTool({ name, arguments: { id: "7" } }))).toBe('"/echo/7"')
  })

  it("validates like the spec loader", () => {
    expect(() =>
      httpTool({
        name: "x",
        description: "d",
        http: { url: "https://a.example/{{input.nope}}" },
        output: { select: "@" },
      }),
    ).toThrow(/does not match a property/)
  })
})
