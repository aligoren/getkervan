// The connect commands, run for real in each shell they are for, with `claude` replaced by a stub
// that prints its arguments one per line. Every argument must arrive exactly: the URL too when it
// is an IPv6 address (`[::1]` is a glob pattern in zsh, which fails the whole command unquoted).
// Each shell runs when it is installed (bash: Git for Windows' on Windows; zsh: Linux, macOS;
// PowerShell: Windows, or pwsh elsewhere).
import { spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { connectCommands, posixQuote, powershellQuote } from "../src/connect.js"

const KEY = "kvn_test-only_0123456789-abcdefghijklmnopqrstuvwxyzABCD"
const ID = "0f8fad5b-d9cb-469f-a165-70867728950e"
const ENDPOINTS = [
  `http://[::1]:4310/s/${ID}/mcp`,
  `https://[2001:db8::1]/s/${ID}/mcp`,
  `http://127.0.0.1:4310/s/${ID}/mcp`,
  `https://studio.example.com/s/${ID}/mcp`,
]
const expected = (endpoint: string) => [
  "mcp",
  "add",
  "--transport",
  "http",
  "weather-1",
  endpoint,
  "--header",
  `Authorization: Bearer ${KEY}`,
]

function available(command: string, args: string[]): boolean {
  if (path.isAbsolute(command) && !existsSync(command)) return false
  return spawnSync(command, args, { stdio: "ignore", timeout: 20_000 }).status === 0
}

const BASH =
  process.platform === "win32"
    ? path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe")
    : "bash"
const hasBash = available(BASH, ["-c", "true"])
const hasZsh = process.platform !== "win32" && available("zsh", ["-c", "true"])
const POWERSHELL = process.platform === "win32" ? "powershell.exe" : "pwsh"
const hasPowerShell = available(POWERSHELL, ["-NoProfile", "-Command", "exit 0"])

// CI names the shells it provides (KERVAN_REQUIRE_SHELLS=bash,zsh on Linux, bash,powershell on
// Windows): a missing one fails here instead of skipping its tests without a word.
const REQUIRED = (process.env.KERVAN_REQUIRE_SHELLS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean)

describe("the shells this run requires (KERVAN_REQUIRE_SHELLS)", () => {
  it("are installed", () => {
    const installed: Record<string, boolean> = {
      bash: hasBash,
      zsh: hasZsh,
      powershell: hasPowerShell,
    }
    // An unknown name counts as missing, so a typo cannot turn the requirement off.
    expect(REQUIRED.filter((name) => installed[name] !== true)).toEqual([])
  })
})

const lines = (text: string) => text.split(/\r?\n/).filter((line) => line !== "")

function posix(shell: string, script: string, stdin = "") {
  const stub = `claude() { for a in "$@"; do printf '%s\\n' "$a"; done; }`
  const result = spawnSync(shell, ["-c", `${stub}\n${script}`], {
    input: stdin,
    encoding: "utf8",
    timeout: 20_000,
  })
  expect(result.stderr).toBe("")
  return lines(result.stdout)
}

function powershell(script: string) {
  const stub = "function claude { foreach ($a in $args) { [Console]::Out.WriteLine($a) } }"
  const result = spawnSync(
    POWERSHELL,
    ["-NoProfile", "-NonInteractive", "-Command", `${stub}\n${script}`],
    { encoding: "utf8", timeout: 30_000 },
  )
  expect(result.stderr).toBe("")
  return lines(result.stdout)
}

describe("quoting", () => {
  it("is a literal word in bash/zsh and PowerShell, quote marks included", () => {
    expect(posixQuote("http://[::1]:4310/x")).toBe("'http://[::1]:4310/x'")
    expect(posixQuote("it's")).toBe(`'it'\\''s'`)
    expect(powershellQuote("it's")).toBe("'it''s'")
    const typographic = `a${String.fromCodePoint(0x2019)}b`
    expect(powershellQuote(typographic)).toBe(`'a${String.fromCodePoint(0x2019, 0x2019)}b'`)
  })

  it("puts the URL in quotes in every command", () => {
    for (const endpoint of ENDPOINTS) {
      const commands = connectCommands("weather-1", endpoint)
      for (const text of [commands.inline(KEY), commands.bash, commands.powershell]) {
        expect(text).toContain(` '${endpoint}' `)
      }
    }
  })
})

for (const [name, run, enabled] of [
  ["bash", (script: string, stdin?: string) => posix(BASH, script, stdin), hasBash],
  ["zsh", (script: string, stdin?: string) => posix("zsh", script, stdin), hasZsh],
] as const) {
  describe.runIf(enabled)(`in ${name}`, () => {
    for (const endpoint of ENDPOINTS) {
      it(`passes every argument exactly: ${endpoint}`, () => {
        const commands = connectCommands("weather-1", endpoint)
        expect(run(commands.inline(KEY))).toEqual(expected(endpoint))
        // The hidden-read variant, with the key typed on stdin; the prompt comes first.
        const output = run(commands.bash, `${KEY}\n`)
        expect(output.slice(-8)).toEqual(expected(endpoint))
        expect(output.join("\n")).not.toMatch(/KERVAN_API_KEY/)
      })
    }

    it("would have failed in zsh without the quotes (the reason for them)", () => {
      const unquoted = `claude mcp add --transport http weather-1 ${ENDPOINTS[0]}`
      const result = spawnSync(
        name === "zsh" ? "zsh" : BASH,
        ["-c", `claude() { :; }\n${unquoted}`],
        {
          encoding: "utf8",
        },
      )
      if (name === "zsh") expect(result.stderr).toMatch(/no matches found/)
      else expect(result.status).toBe(0)
    })
  })
}

describe.runIf(hasPowerShell)("in PowerShell", () => {
  for (const endpoint of ENDPOINTS) {
    it(`passes every argument exactly: ${endpoint}`, () => {
      const commands = connectCommands("weather-1", endpoint)
      expect(powershell(commands.inline(KEY))).toEqual(expected(endpoint))
      // The hidden-read variant, after its two Read-Host lines (the key set as they would set it).
      const [, , add] = commands.powershell.split("\n")
      expect(powershell(`$env:KERVAN_API_KEY = '${KEY}'\n${add}`)).toEqual(expected(endpoint))
    })
  }
})
