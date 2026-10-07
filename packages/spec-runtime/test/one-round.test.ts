// Spec problems in as few rounds as possible: every structural problem at once, with a note that
// more checks follow; every semantic problem at once; and an http:// refusal that fits the tool.
import { describe, expect, it } from "vitest"
import { loadSpec, SpecLoadError } from "../src/index.js"
import { STRUCTURE_FIRST } from "../src/load.js"

const noSecrets = { get: () => undefined }

async function problems(text: string) {
  try {
    await loadSpec(text, { secrets: noSecrets })
  } catch (error) {
    if (error instanceof SpecLoadError) return error
    throw error
  }
  throw new Error("the spec loaded")
}

describe("structural problems", () => {
  it("are all reported, with a note that more checks run once they are fixed", async () => {
    const error = await problems(`specVersion: 1
name: x
version: 0.1.0
tools:
  - name: a
    description: first
    retries: 3
    http: { url: "http://api.example.com/a?q={{input.qq}}" }
    output: { select: "@" }
  - name: b
    description: second
    http: { url: "https://api.example.com/b", method: FETCH }
    output: { select: "@" }
`)
    const errors = error.issues.filter((issue) => issue.severity === "error")
    expect(errors.map((issue) => issue.path.join("."))).toEqual(
      expect.arrayContaining(["tools.0", "tools.1.http.method"]),
    )
    expect(error.issues.at(-1)).toEqual({ path: [], message: STRUCTURE_FIRST, severity: "warning" })
    expect(error.message).toContain(STRUCTURE_FIRST)
    // The semantic checks wait: no http:// or {{input.qq}} problem yet.
    expect(error.message).not.toMatch(/http:\/\/ is not allowed|does not match a property/)
  })
})

describe("semantic problems", () => {
  it("are all reported in one round", async () => {
    const error = await problems(`specVersion: 1
name: x
version: 0.1.0
tools:
  - name: a
    description: first
    input: { type: object, properties: { q: { type: string } } }
    http: { url: "http://api.example.com/a", query: { q: "{{input.qq}}" } }
    output: { select: "@" }
`)
    expect(error.message).toMatch(/http:\/\/ is not allowed/)
    expect(error.message).toMatch(/\{\{input\.qq\}\} does not match a property/)
    expect(error.message).not.toContain(STRUCTURE_FIRST)
  })
})

describe("the http:// refusal", () => {
  const spec = (http: string, head = "") => `specVersion: 1
name: x
version: 0.1.0
${head}tools:
  - name: a
    description: first
    http: ${http}
    output: { select: "@" }
`
  it("for a tool without secrets, does not talk about secrets", async () => {
    const error = await problems(spec(`{ url: "http://api.example.com/a" }`))
    expect(error.message).toContain(
      "Plain http:// is not allowed by default: requests and answers would travel unencrypted. Use https://, or set allowInsecureHttp: true for an API that only speaks http.",
    )
    expect(error.message).not.toContain("secrets")
  })

  it("for a tool that sends secrets, says that is why", async () => {
    const error = await problems(
      spec(
        `{ url: "http://api.example.com/a", headers: { X-Key: "{{secrets.API_KEY}}" } }`,
        "secrets: [API_KEY]\n",
      ),
    )
    expect(error.message).toContain(
      "Plain http:// is not allowed: this tool sends secrets, which would travel unencrypted. Use https://.",
    )
  })
})
