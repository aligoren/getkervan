// Security review (release, terminal): `kervan run` prints text from the spec file to the
// terminal. A spec is often someone else's file (a Studio export written by a member, one shared
// online), so its text cannot send terminal control sequences (ANSI/OSC: retitle the window,
// erase or rewrite lines, hyperlinks) or start fake lines of its own.
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PassThrough, Writable } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import { runSpec } from "../../src/run.js"
import { SpecHost } from "../../src/spec-host.js"
import { terminalSafe } from "../../src/terminal.js"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function specFile(text: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kervan-review-term-"))
  dirs.push(dir)
  const file = path.join(dir, "kervan.yaml")
  await writeFile(file, text)
  return file
}

// C0/C1 controls other than the tab; a printed line may not hold a line break of its own either.
const CONTROL = {
  test: (line: string) =>
    [...line].some((c) => {
      const code = c.codePointAt(0) ?? 0
      return (code < 0x20 && code !== 0x09 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f)
    }),
}
const visible = (line: string) => JSON.stringify(line)

/** `kervan run` on a spec file (stdio), with what it printed to stderr. */
async function run(file: string): Promise<{ code: number; stderr: string }> {
  let stderr = ""
  const sink = new Writable({
    write(chunk, _encoding, done) {
      stderr += String(chunk)
      done()
    },
  })
  const code = await runSpec({
    spec: file,
    mode: "stdio",
    port: 0,
    host: "127.0.0.1",
    allowedHosts: [],
    envFiles: [],
    watch: false,
    allowPrivateNetwork: false,
    allowInsecureSecrets: false,
    denyNetwork: [],
    cwd: path.dirname(file),
    env: {},
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: sink,
  })
  return { code, stderr }
}

describe("kervan run's terminal output", () => {
  it("does not pass a spec's name and version to the terminal raw", async () => {
    // YAML escapes: \e is ESC, \a is BEL, \n a line break.
    const file = await specFile(String.raw`specVersion: 1
name: "weather\e]0;pwned\a\e[1A\e[2K"
version: "1.0.0\nServing weather on https://attacker.example/mcp"
tools:
  - name: forecast
    description: Gets the forecast.
    http:
      url: https://api.example.test/forecast
    output: { select: "@" }
`)
    // Such a spec does not load (name and version may not hold control characters), and the
    // message that says so names the characters without sending them.
    const { code, stderr } = await run(file)
    expect(code).toBe(1)
    expect(stderr).toContain("U+001B")
    expect(stderr).not.toContain("Serving weather")
    expect(
      stderr
        .split("\n")
        .filter((line) => CONTROL.test(line))
        .map(visible),
    ).toEqual([])
  })

  it("prints a spec's own name in the Loaded line", async () => {
    const file = await specFile(`specVersion: 1
name: weather
version: 1.0.0
tools:
  - name: forecast
    description: Gets the forecast.
    http:
      url: https://api.example.test/forecast
    output: { select: "@" }
`)
    const printed: string[] = []
    await SpecHost.start({ file, env: {}, print: (line) => printed.push(line) })
    expect(printed).toContain("Loaded weather 1.0.0: 1 tool(s)")
  })

  it("does not pass a spec's unknown field names to the terminal raw in errors", async () => {
    const file = await specFile(String.raw`specVersion: 1
name: weather
version: 1.0.0
"x\e[2K\rError: none. Serving weather on http://127.0.0.1:3000/mcp\e[8m": 1
tools: []
`)
    const { code, stderr } = await run(file)
    expect(code).toBe(1)
    // Printed raw, ESC[2K would erase the line, CR return to its start, the fake "Serving ..."
    // text replace the error, and ESC[8m hide whatever follows.
    expect(
      stderr
        .split("\n")
        .filter((line) => CONTROL.test(line))
        .map(visible),
    ).toEqual([])
  })
})

describe("kervan run's own output sink", () => {
  it("escapes control characters from any source, not only spec text (a file name)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kervan-review-term-"))
    dirs.push(dir)
    // A path that does not exist: the error names it. ESC is not a valid file-name character on
    // Windows, so the file is never created; the name only travels through the message.
    const { code, stderr } = await run(path.join(dir, `x${String.fromCharCode(0x1b)}[2K.yaml`))
    expect(code).toBe(1)
    expect(stderr).toContain(`x${String.fromCharCode(92)}u001B[2K`)
    expect(stderr.split("\n").filter((line) => CONTROL.test(line))).toEqual([])
  })
})

describe("terminalSafe", () => {
  const ch = (...codePoints: number[]) => String.fromCodePoint(...codePoints)
  const escaped = (code: string) => `${String.fromCharCode(92)}u${code}`

  it("writes controls, bidi and format characters as visible escapes", () => {
    expect(terminalSafe(`a${ch(0x1b)}]52;c;x${ch(0x07)}b`)).toBe(
      `a${escaped("001B")}]52;c;x${escaped("0007")}b`,
    )
    expect(terminalSafe(`ok${ch(0x0d)}fake`)).toBe(`ok${escaped("000D")}fake`)
    expect(terminalSafe(`${ch(0x9b)}2K`)).toBe(`${escaped("009B")}2K`)
    expect(terminalSafe(`x${ch(0x202e)}y${ch(0xe0049)}`)).toBe(
      `x${escaped("202E")}y${String.fromCharCode(92)}u{E0049}`,
    )
  })

  it("keeps lines, tabs, any script and emoji joiners", () => {
    const text = `${ch(0x015f)}ehir\tad${ch(0x0131)}\n${ch(0x0645, 0x06cc, 0x200c, 0x062e)} ${ch(0x1f468, 0x200d, 0x1f469)}`
    expect(terminalSafe(text)).toBe(text)
  })
})
