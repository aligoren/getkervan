// Security review (release): text a member writes into a spec (the server's name and description,
// tool titles and descriptions) reaches other people and the model through the gateway's
// tools/list and server info, and the playground. Like names and emails (T17), it may not hide
// anything: a spec with invisible, bidi or terminal control characters is not published, and
// ordinary text in any script (with line breaks, ZWNJ and emoji joiners) is.
//
// No invisible character is written literally here: the YAML uses escapes for ESC, U+202E and tag
// characters, and the rest is built from code points.
import { afterEach, describe, expect, it } from "vitest"
import { hasUnsafeCharacters } from "../../src/display-text.js"
import { StudioError } from "../../src/studio.js"
import { connect, publishedServer, startTestStudio } from "../helpers.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

// Tag characters (U+E0000 block) spell "IGNORE" invisibly: people reviewing the tool see
// nothing, a model reads the text. U+202E reverses what follows; ESC starts a terminal sequence.
const HIDDEN = String.raw`\U000E0049\U000E0047\U000E004E\U000E004F\U000E0052\U000E0045`
// The YAML escape for U+202E, built so no tool turns it into the character itself.
const RLO = `${"\\"}u202E`
const SPEC = String.raw`specVersion: 1
name: "weather\e]0;owned\a\e[2K"
version: 1.0.0
description: "Weather tools${HIDDEN}"
tools:
  - name: forecast
    title: "Forecast ${RLO}txt.exe"
    description: "Gets the forecast.${HIDDEN}"
    http:
      url: https://api.example.test/forecast
    output: { select: "@" }
`

describe("spec text seen by MCP clients and the model", () => {
  it("is not published with invisible, bidi or terminal control characters", async () => {
    const t = await startTestStudio()
    cleanups.push(t.close)
    const refused = await publishedServer(t, SPEC).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(refused).toBeInstanceOf(StudioError)
    const issues = (refused as StudioError).issues.map((issue) => issue.message)
    // Each field is named, with the code point, so the author can find and remove it.
    expect(issues.join("\n")).toMatch(/U\+001B/)
    expect(issues.join("\n")).toMatch(/U\+202E/)
    expect(issues.join("\n")).toMatch(/U\+E0049/)
    for (const message of issues) expect(hasUnsafeCharacters(message)).toBe(false)
  })

  it("is published as written in any script, with line breaks, ZWNJ and emoji joiners", async () => {
    const t = await startTestStudio()
    cleanups.push(t.close)
    const zwnj = String.fromCodePoint(0x200c)
    const family = String.fromCodePoint(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467)
    const persian = `می${zwnj}خواهم`
    const description = `Hava durumu: şehir adı verin.\n${persian} ${family}`
    const published = await publishedServer(
      t,
      `specVersion: 1
name: "Hava ${family}"
version: 1.0.0
tools:
  - name: forecast
    title: "Tahmin ${persian}"
    description: ${JSON.stringify(description)}
    http:
      url: https://api.example.test/forecast
    output: { select: "@" }
`,
    )
    const client = await connect(published.mcpUrl, published.key)
    cleanups.push(() => client.close())
    const [tool] = (await client.listTools()).tools
    expect(client.getServerVersion()?.name).toBe(`Hava ${family}`)
    expect(tool?.title).toBe(`Tahmin ${persian}`)
    expect(tool?.description).toBe(description)
  })
})
