// `kervan <command> --help`: each command prints its own usage and options (stdout, exit 0), the
// same option lines the general help lists for it. Unknown commands and `kervan studio --help`
// (forwarded to Studio, see studio.test.ts) keep their behavior.
import { describe, expect, it } from "vitest"
import { run } from "../src/index.js"

async function capture(argv: string[], version?: string) {
  const out: string[] = []
  const err: string[] = []
  const code = await run(argv, {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...(version ? { runtime: { version, platform: "linux", typescript: "strip" } } : {}),
  })
  return { code, out: out.join("\n"), err: err.join("\n") }
}

/** The option lines the general help lists under one command. */
async function generalOptions(usage: string): Promise<string[]> {
  const { out } = await capture(["--help"])
  const lines = out.split("\n")
  const start = lines.findIndex((line) => line.startsWith(`  ${usage} `))
  const options: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("    ")) break
    options.push(line.trim())
  }
  return options
}

describe("kervan <command> --help", () => {
  for (const [command, usage] of [
    ["create", "create <dir>"],
    ["dev", "dev <entry>"],
    ["run", "run <spec>"],
  ] as const) {
    it(`${command}: its usage and every option of the general help`, async () => {
      const result = await capture([command, "--help"])
      expect(result.code).toBe(0)
      expect(result.err).toBe("")
      expect(result.out.startsWith(`Usage: kervan ${usage} [options]\n`)).toBe(true)
      const options = await generalOptions(usage)
      expect(options.length).toBeGreaterThan(2)
      for (const option of options) expect(result.out).toContain(`  ${option}\n`)
      expect(result.out).toContain("  -h, --help")
      expect(result.out).not.toContain("Commands:")
    })
  }

  it("also as -h, after arguments, and on a Node.js the commands refuse", async () => {
    expect((await capture(["run", "-h"])).out).toMatch(/^Usage: kervan run <spec>/)
    expect((await capture(["run", "kervan.yaml", "--http", "--help"])).out).toMatch(
      /^Usage: kervan run <spec>/,
    )
    const old = await capture(["dev", "--help"], "v24.15.0")
    expect(old.code).toBe(0)
    expect(old.out).toMatch(/^Usage: kervan dev <entry>/)
  })

  it("leaves the general help and unknown commands as they were", async () => {
    const general = await capture(["--help"])
    expect(general.code).toBe(0)
    expect(general.out).toMatch(
      /^Usage: kervan <command> \[options\]\n\nCommands:\n {2}create <dir> {3}Create/,
    )
    const unknown = await capture(["bogus", "--help"])
    expect(unknown.code).toBe(1)
    expect(unknown.err).toMatch(/^Unknown command "bogus"\./)
  })
})
