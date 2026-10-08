// The data the website shows from real runs (site/data/generated, written by
// scripts/site/generate.mjs) still matches the example spec and the commands. No network: the
// recorded tool calls are checked against the output schema the server lists now.
import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { cliHelp, offlineAnswers, specFingerprint, startSpec } from "../site/generate.mjs"

const read = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
const example = JSON.parse(read("site/data/generated/example.json"))

type Schema = { type?: string; properties?: Record<string, Schema>; required?: string[] }

/** The parts of JSON Schema the example's output schemas use: types, properties, required. */
function schemaProblems(value: unknown, schema: Schema, at = "$"): string[] {
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value
  if (schema.type === "integer" && !Number.isInteger(value)) return [`${at} is not an integer`]
  if (schema.type && schema.type !== "integer" && schema.type !== type)
    return [`${at} is ${type}, not ${schema.type}`]
  if (type !== "object") return []
  const object = value as Record<string, unknown>
  const missing = (schema.required ?? [])
    .filter((key) => !(key in object))
    .map((key) => `${at}.${key} is missing`)
  const nested = Object.entries(schema.properties ?? {}).flatMap(([key, sub]) =>
    key in object ? schemaProblems(object[key], sub, `${at}.${key}`) : [],
  )
  return [...missing, ...nested]
}

describe("the website's generated data", () => {
  let server: Awaited<ReturnType<typeof startSpec>>
  let fresh: Awaited<ReturnType<typeof offlineAnswers>>

  beforeAll(async () => {
    server = await startSpec()
    fresh = await offlineAnswers(server.url)
  }, 60_000)

  afterAll(async () => {
    await server?.stop()
  })

  it("was made from the current examples/spec/kervan.yaml (else run `node scripts/site/generate.mjs`)", () => {
    expect(example.spec).toBe("examples/spec/kervan.yaml")
    expect(example.specSha256).toBe(specFingerprint(read("examples/spec/kervan.yaml")))
  })

  it("shows what the server answers today to server/discover and tools/list", () => {
    expect(example.discover.result).toEqual(fresh.discover.result)
    expect(example.toolsList.result).toEqual(fresh.toolsList.result)
    const { id: _a, ...recorded } = example.toolsList.request
    const { id: _b, ...now } = fresh.toolsList.request
    expect(recorded).toEqual(now)
  })

  it("shows recorded calls that fit the tools' current input and output schemas", () => {
    const tools = new Map(
      fresh.toolsList.result.tools.map((tool: { name: string }) => [tool.name, tool]),
    )
    expect(example.calls.length).toBeGreaterThanOrEqual(2)
    expect(
      example.calls.some(
        (call: { result: { structuredContent?: unknown } }) => call.result.structuredContent,
      ),
    ).toBe(true)
    for (const call of example.calls) {
      const tool = tools.get(call.request.params.name) as {
        inputSchema: Schema
        outputSchema?: Schema
      }
      expect(tool, call.request.params.name).toBeDefined()
      expect(schemaProblems(call.request.params.arguments, tool.inputSchema)).toEqual([])
      expect(call.result.isError ?? false).toBe(false)
      if (tool.outputSchema)
        expect(schemaProblems(call.result.structuredContent, tool.outputSchema)).toEqual([])
      else expect(call.result.content.length).toBeGreaterThan(0)
    }
    expect(Date.parse(example.callsCapturedAt)).toBeLessThanOrEqual(Date.now())
  })

  it("has the current --help of kervan and kervan-studio", () => {
    expect(JSON.parse(read("site/data/generated/cli-help.json"))).toEqual(cliHelp())
  })
})
