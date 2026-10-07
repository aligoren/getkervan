// Security review (release): the fixes, each pinned on its own. Text people and the model read
// holds no invisible or control characters; numbers that hold a secret are redacted, also when
// parsing would round them; select runs in a separate process that is stopped when it runs too
// long or out of memory, and that never keeps this process alive.
//
// No invisible character is written literally here: they are built from code points.
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { ToolError } from "@kervan/core"
import { describe, expect, it } from "vitest"
import { loadSpec, SecretVault, SpecLoadError } from "../../src/index.js"
import { SelectError, select } from "../../src/select.js"

const ch = (...codePoints: number[]) => String.fromCodePoint(...codePoints)

async function issues(text: string): Promise<string[]> {
  try {
    await loadSpec(text, { secrets: { get: () => undefined } })
    return []
  } catch (error) {
    if (error instanceof SpecLoadError) return error.issues.map((issue) => issue.message)
    throw error
  }
}

const spec =
  (fields: { name?: string; version?: string; description?: string } = {}) =>
  (tool: { title?: string; description?: string; property?: string } = {}) =>
    `specVersion: 1
name: ${JSON.stringify(fields.name ?? "weather")}
version: ${JSON.stringify(fields.version ?? "1.0.0")}
${fields.description === undefined ? "" : `description: ${JSON.stringify(fields.description)}`}
tools:
  - name: forecast
    ${tool.title === undefined ? "" : `title: ${JSON.stringify(tool.title)}`}
    description: ${JSON.stringify(tool.description ?? "Gets the forecast.")}
    input:
      type: object
      properties:
        city: { type: string, description: ${JSON.stringify(tool.property ?? "A city")} }
    http:
      url: https://api.example.test/forecast
    output: { select: "@" }
`

describe("text people and the model read", () => {
  const hidden = [
    ["escape", 0x1b],
    ["carriage return", 0x0d],
    ["C1 control sequence introducer", 0x9b],
    ["right-to-left override", 0x202e],
    ["right-to-left isolate", 0x2067],
    ["zero-width space", 0x200b],
    ["tag letter", 0xe0049],
    ["byte order mark", 0xfeff],
    ["line separator", 0x2028],
    ["Hangul filler", 0x3164],
  ] as const

  it.each(hidden)("refuses a %s in every field", async (_name, codePoint) => {
    const bad = `a${ch(codePoint)}b`
    const code = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`
    for (const text of [
      spec({ name: bad })(),
      spec({ version: bad })(),
      spec({ description: bad })(),
      spec()({ title: bad }),
      spec()({ description: bad }),
      spec()({ property: bad }),
    ]) {
      const found = await issues(text)
      expect(found.join("\n"), text).toContain(`invisible or control character (${code})`)
    }
  })

  it("refuses a line break in names, versions and titles, not in descriptions", async () => {
    expect(await issues(spec({ name: "a\nb" })())).not.toEqual([])
    expect(await issues(spec({ version: "1\n2" })())).not.toEqual([])
    expect(await issues(spec()({ title: "a\nb" }))).not.toEqual([])
    expect(await issues(spec({ description: "One.\n\tTwo." })({ description: "a\nb" }))).toEqual([])
  })

  it("accepts any script, ZWNJ and emoji joiners", async () => {
    const persian = `${ch(0x0645, 0x06cc, 0x200c)}${ch(0x062e, 0x0648, 0x0627, 0x0647, 0x0645)}`
    const family = ch(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)
    const turkish = `${ch(0x015f)}ehir ad${ch(0x0131)} ${ch(0x0130)}zmir`
    expect(
      await issues(
        spec({ name: `Hava ${family}`, description: `${turkish}\n${persian}` })({
          title: persian,
          description: `${turkish} ${family}`,
          property: persian,
        }),
      ),
    ).toEqual([])
  })

  it("quotes an unknown field's name with anything invisible spelled out", async () => {
    // YAML escapes in a quoted key: a backslash and "e" is ESC, a backslash and "n" a line feed.
    const bs = String.fromCharCode(92)
    const found = await issues(spec()().replace("tools:", `"x${bs}e[2K${bs}nServing": 1\ntools:`))
    const message = found.find((text) => text.startsWith("Unknown field(s)")) ?? ""
    expect(message).toContain(`"x${String.fromCharCode(92)}u001B[2K`)
    expect(message).not.toMatch(/[\p{Cc}]/u)
  })
})

describe("a number that holds a secret", () => {
  const SHORT = "820461937520"
  const LONG = "12345678901234567890123"

  it("is redacted in values, also as JSON text that parsing would round", () => {
    const vault = new SecretVault()
    vault.add("SHORT", SHORT)
    vault.add("LONG", LONG)
    expect(vault.redactValue({ a: Number(SHORT), b: 42, c: [Number(`9${SHORT}`)] })).toEqual({
      a: "[redacted]",
      b: 42,
      c: ["[redacted]"],
    })
    // The long one does not survive JSON.parse digit for digit; its source text is checked.
    expect(String(JSON.parse(LONG))).not.toContain(LONG)
    expect(vault.parseJson(`{"id":${LONG},"n":7,"s":"x${SHORT}"}`)).toEqual({
      id: "[redacted]",
      n: 7,
      s: "x[redacted]",
    })
  })
})

describe("select in a separate process", () => {
  const options = { timeoutMs: 2_000, maxChars: 1_000 }

  it("returns the result as JSON text and its length", async () => {
    expect(await select({ a: { b: [1, 2] } }, "a.b", options)).toEqual({
      length: 5,
      text: "[1,2]",
    })
    const long = await select({ s: "x".repeat(50) }, "s", { ...options, maxChars: 10 })
    expect(long.length).toBe(52)
    expect(long.text).toHaveLength(11)
  })

  it("stops an expression that runs longer than the timeout", async () => {
    const made = (n: number) => `split(pad_left('a', \`${n}\`), '')`
    const slow = `length(map(&length(map(&length(map(&\`1\`, ${made(1000)})), ${made(1000)})), ${made(1000)}))`
    const started = Date.now()
    await expect(select({}, slow, { ...options, timeoutMs: 500 })).rejects.toThrow(
      new ToolError(
        "output.select took longer than 500 ms and was stopped. Simplify the expression.",
      ),
    )
    expect(Date.now() - started).toBeLessThan(3_000)
    // The next one gets a fresh process.
    expect((await select({ a: 1 }, "a", options)).text).toBe("1")
  }, 20_000)

  it("stops an expression that runs out of memory, and carries on", async () => {
    await expect(select({}, "length(pad_left('a', `500000000`))", options)).rejects.toThrow(
      ToolError,
    )
    expect((await select({ a: 1 }, "a", options)).text).toBe("1")
  }, 20_000)

  it("has a memory limit of its own: data that grows step by step is stopped too", async () => {
    // 6,000 x 6,000 entries, built gradually from the document itself ($).
    const list = Array.from({ length: 6_000 }, (_, index) => index)
    await expect(
      select({ list }, "map(&map(&@, $.list), $.list)", { ...options, timeoutMs: 30_000 }),
    ).rejects.toThrow("output.select needed more memory than it may use")
  }, 40_000)

  it("reports an evaluation error as a SelectError (not shown to clients)", async () => {
    await expect(select({ a: "text" }, "abs(a)", options)).rejects.toBeInstanceOf(SelectError)
  })

  it("does not keep the process alive once idle", async () => {
    const dist = pathToFileURL(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist/select.js"),
    ).href
    const script = `
      import { select } from ${JSON.stringify(dist)}
      const result = await select({ a: 1 }, "a", { timeoutMs: 5000, maxChars: 100 })
      console.log(result.text)
    `
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      stdio: ["ignore", "pipe", "ignore"],
    })
    let out = ""
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString()
    })
    const killer = setTimeout(() => child.kill(), 10_000)
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
    clearTimeout(killer)
    expect(out.trim()).toBe("1")
    expect(code).toBe(0)
  }, 20_000)
})
