import { readFileSync } from "node:fs"
import http from "node:http"
import https from "node:https"
import { describe, expect, it, vi } from "vitest"
import { SCHEMA_ID } from "../scripts/schema-id.mjs"
import { loadSpec, SpecLoadError, specJsonSchema } from "../src/index.js"

const noSecrets = { get: () => undefined }

const tool = (extra = "", http = "url: https://api.example.com/v1/items") => `
  - name: list_items
    description: Lists items
    input:
      type: object
      properties: { q: { type: string } }
    http:
      ${http}
    output:
      select: items
${extra}`

const spec = (tools = tool(), head = "") => `specVersion: 1
name: test
version: 0.1.0
${head}
tools:${tools}`

async function errorsOf(
  text: string,
  secrets: { get(name: string): string | undefined } = noSecrets,
) {
  try {
    await loadSpec(text, { secrets })
  } catch (error) {
    if (error instanceof SpecLoadError) return error.message
    throw error
  }
  throw new Error("expected the spec to be rejected")
}

describe("loading", () => {
  it("loads a valid spec", async () => {
    const loaded = await loadSpec(spec(), { secrets: noSecrets })
    expect(loaded.spec.name).toBe("test")
    expect(loaded.tools.map((t) => t.name)).toEqual(["list_items"])
    expect(loaded.warnings).toEqual([])
  })

  it("reports problems with file, line and column", async () => {
    const message = await errorsOf(
      spec(tool("", "url: https://api.example.com\n      method: FETCH")),
    )
    expect(message).toMatch(/kervan\.yaml:\d+:\d+ tools\[0\]\.http\.method: /)
  })

  it.each([
    ["an unknown field", spec(tool("    colour: red")), /Unknown field\(s\): colour/],
    ["a wrong specVersion", spec().replace("specVersion: 1", "specVersion: 2"), /specVersion/],
    [
      "neither select nor raw",
      spec().replace("      select: items", "      maxOutputChars: 5"),
      /tools\[0\]\.output/,
    ],
    [
      "an invalid JMESPath",
      spec().replace("select: items", "select: 'items[?'"),
      /not a valid JMESPath expression/,
    ],
    [
      "a select longer than 1000 characters",
      spec().replace("select: items", `select: ${"a".repeat(1001)}`),
      /tools\[0\]\.output/,
    ],
    [
      "an undeclared secret",
      spec(
        tool("", 'url: https://api.example.com\n      headers: { X-Key: "{{secrets.API_KEY}}" }'),
      ),
      /secrets\.API_KEY.*not declared/,
    ],
    [
      "an input reference the schema does not have",
      spec(tool("", "url: https://api.example.com/{{input.missing}}")),
      /input\.missing.*does not match/,
    ],
    [
      "a template in the host",
      spec(tool("", "url: https://{{input.q}}.example.com/v1")),
      /host and port cannot be templated/,
    ],
    [
      "a template in the port",
      spec(tool("", "url: 'https://api.example.com:{{input.q}}/v1'")),
      /not a valid absolute URL|host and port/,
    ],
    [
      "credentials in the URL",
      spec(tool("", "url: https://admin:hunter22@api.example.com/v1")),
      /must not contain credentials/,
    ],
    [
      "plain http",
      spec(tool("", "url: http://api.example.com/v1")),
      /Plain http:\/\/ is not allowed/,
    ],
    ["a non-http scheme", spec(tool("", "url: file:///etc/passwd")), /Only https/],
    [
      "a template in the URL query",
      spec(tool("", "url: https://api.example.com/v1?q={{input.q}}")),
      /use http\.query/,
    ],
    [
      "a reserved header",
      spec(tool("", "url: https://api.example.com\n      headers: { Host: evil.example }")),
      /"Host" header is managed by Kervan/,
    ],
    [
      "an invalid header name",
      spec(tool("", 'url: https://api.example.com\n      headers: { "X Bad": "1" }')),
      /not a valid header name/,
    ],
    [
      "a body on GET",
      spec(tool("", "url: https://api.example.com\n      body: { a: 1 }")),
      /GET request cannot have a body/,
    ],
    [
      "an unsupported template expression",
      spec(tool("", 'url: https://api.example.com\n      query: { q: "{{ input.q | upper }}" }')),
      /Unsupported template/,
    ],
    [
      "a non-object input schema",
      spec(tool().replace("type: object", "type: string")),
      /input schema must have type: "object"/,
    ],
    ["a duplicate tool name", spec(tool() + tool()), /Duplicate tool name "list_items"/],
    ["invalid YAML", "specVersion: 1\nname: [unclosed\n", /kervan\.yaml:\d+:\d+/],
    [
      "a duplicate key",
      spec().replace("name: test", "name: test\nname: again"),
      /kervan\.yaml:\d+:\d+/,
    ],
    ["a custom tag", spec().replace("name: test", "name: !!js/function 'x'"), /kervan\.yaml/],
  ])("rejects %s", async (_label, text, pattern) => {
    expect(await errorsOf(text)).toMatch(pattern)
  })

  it("rejects alias bombs", async () => {
    const bomb = [
      "a: &a [x, x, x, x, x, x, x, x, x, x]",
      "b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]",
      "c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]",
      "d: [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]",
    ].join("\n")
    expect(await errorsOf(bomb)).toMatch(/alias/i)
  })

  it("rejects specs over 1 MiB", async () => {
    expect(await errorsOf(`${spec()}\n# ${"x".repeat(1024 * 1024)}`)).toMatch(/larger than/)
  })
})

describe("secrets at load time", () => {
  const withSecret = spec(
    tool("", 'url: https://api.example.com\n      headers: { X-Key: "{{secrets.API_KEY}}" }'),
    "secrets: [API_KEY, UNUSED_KEY]",
  )

  it("rejects secrets shorter than 8 characters", async () => {
    expect(
      await errorsOf(withSecret, { get: (name) => (name === "API_KEY" ? "short" : undefined) }),
    ).toMatch(/Secret API_KEY is shorter than 8 characters/)
  })

  it("warns about missing and unused secrets, without failing", async () => {
    const loaded = await loadSpec(withSecret, { secrets: noSecrets })
    const warnings = loaded.warnings.map((w) => w.message)
    expect(warnings).toContain("Secret UNUSED_KEY is declared but never used.")
    expect(warnings).toContain(
      "Secret API_KEY is not configured for api.example.com:443; tools that use it there fail until it is.",
    )
  })

  it("never puts a secret value in an error message", async () => {
    const message = await errorsOf(withSecret, { get: () => "abc" })
    expect(message).not.toContain('"abc"')
    expect(message).not.toMatch(/\babc\b/)
  })
})

describe("published JSON Schema", () => {
  it("is up to date with the spec schema (run `pnpm --filter @kervan/spec-runtime gen:schema`)", () => {
    const { $id, ...committed } = JSON.parse(
      readFileSync(new URL("../schema/kervan.schema.json", import.meta.url), "utf8"),
    )
    expect(committed).toEqual(specJsonSchema())
    // Its public name; editors use it as an identifier, nothing fetches it.
    expect($id).toBe(SCHEMA_ID)
  })

  it("validates offline: the schema ships in the package and nothing is fetched", async () => {
    const fetched = vi.fn(() => Promise.reject(new Error("no network in this test")))
    vi.stubGlobal("fetch", fetched)
    const httpsRequest = vi.spyOn(https, "request")
    const httpsGet = vi.spyOn(https, "get")
    const httpRequest = vi.spyOn(http, "request")
    try {
      // A spec that names the schema by its public id still loads, without going to the network.
      const loaded = await loadSpec(
        `$schema: ${SCHEMA_ID}\nspecVersion: 1\nname: offline\nversion: 0.1.0\ntools:${tool()}`,
        { secrets: noSecrets },
      )
      expect(loaded.tools.map((t) => t.name)).toEqual(["list_items"])
      await expect(
        loadSpec(`$schema: ${SCHEMA_ID}\nspecVersion: 2\nname: offline\ntools: []\n`, {
          secrets: noSecrets,
        }),
      ).rejects.toBeInstanceOf(SpecLoadError)
      expect(fetched).not.toHaveBeenCalled()
      expect(httpsRequest).not.toHaveBeenCalled()
      expect(httpsGet).not.toHaveBeenCalled()
      expect(httpRequest).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
    }
  })

  it("is in the package, at the path editors and Studio import", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    expect(pkg.exports["./schema/kervan.schema.json"]).toBe("./schema/kervan.schema.json")
    expect(pkg.files).toContain("schema")
  })

  it("describes the fields an editor completes", () => {
    const schema = specJsonSchema() as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["specVersion", "name", "version", "secrets", "defaults", "tools"]),
    )
    expect(schema.required).toEqual(expect.arrayContaining(["specVersion", "name", "tools"]))
  })
})
