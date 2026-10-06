import { createApp, InMemoryToolRegistry } from "@kervan/core"
import { describe, expect, it } from "vitest"
import { applySpec, loadSpec, parseTemplate, SecretVault, TemplateError } from "../src/index.js"

describe("template grammar", () => {
  it("parses input paths and secrets, with whitespace", () => {
    expect(parseTemplate("a {{ input.user.id }} b {{secrets.API_KEY}}")).toEqual([
      { kind: "text", text: "a " },
      { kind: "input", path: ["user", "id"] },
      { kind: "text", text: " b " },
      { kind: "secret", name: "API_KEY" },
    ])
  })

  it("writes a literal {{ for \\{{", () => {
    expect(parseTemplate("\\{{ not a template }}")).toEqual([
      { kind: "text", text: "{{ not a template }}" },
    ])
  })

  it.each([
    "{{ input }}",
    "{{ input.a | upper }}",
    "{{ input.a + 1 }}",
    "{{ secrets.lower }}",
    "{{ env.HOME }}",
    "{{ constructor.constructor('x')() }}",
    "{{ input['a'] }}",
    "{{ input.a",
  ])("rejects %j", (source) => {
    expect(() => parseTemplate(source)).toThrow(TemplateError)
  })
})

describe("SecretVault", () => {
  it("redacts raw, URL-encoded, form-encoded and JSON-escaped forms", () => {
    const vault = new SecretVault()
    const secret = 'pa ss+/"word\\1'
    vault.add("S", secret)
    const forms = [
      secret,
      encodeURIComponent(secret),
      new URLSearchParams({ v: secret }).toString().slice(2),
      JSON.stringify(secret).slice(1, -1),
    ]
    for (const form of forms) expect(vault.redact(`<${form}>`)).toBe("<[redacted]>")
    expect(vault.redactValue({ a: [forms[1], { b: forms[3] }] })).toEqual({
      a: ["[redacted]", { b: "[redacted]" }],
    })
  })

  it("rejects values shorter than 8 characters", () => {
    expect(() => new SecretVault().add("S", "1234567")).toThrow(/shorter than 8/)
  })
})

describe("applySpec", () => {
  const text = (descriptionB: string) => `specVersion: 1
name: reload
version: 0.0.0
tools:
  - { name: a, description: A, http: { url: https://api.example.com/a }, output: { select: "@" } }
  - { name: b, description: ${descriptionB}, http: { url: https://api.example.com/b }, output: { select: "@" } }
`
  const options = { secrets: { get: () => undefined } }

  it("touches only the tools whose spec changed", async () => {
    const registry = new InMemoryToolRegistry()
    let signatures = applySpec(registry, await loadSpec(text("B"), options))
    const [a1, b1] = registry.list()

    signatures = applySpec(registry, await loadSpec(text("B"), options), signatures)
    expect(registry.list()[0]).toBe(a1)
    expect(registry.list()[1]).toBe(b1)

    signatures = applySpec(registry, await loadSpec(text("B changed"), options), signatures)
    expect(registry.list()[0]).toBe(a1)
    expect(registry.list()[1]).not.toBe(b1)
    expect(registry.list()[1]?.description).toBe("B changed")

    applySpec(
      registry,
      await loadSpec(text("B changed").split("\n  - { name: b")[0] ?? "", options),
      signatures,
    )
    expect(registry.list().map((t) => t.name)).toEqual(["a"])
  })

  it("serves spec tools from an app", async () => {
    const app = createApp({ name: "x", version: "0" })
    applySpec(app.registry, await loadSpec(text("B"), options))
    expect(app.listTools().map((t) => t.name)).toEqual(["a", "b"])
  })
})
