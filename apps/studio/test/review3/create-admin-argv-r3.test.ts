// Security review 3: `kervan-studio create-admin` and a password given as an argument.
//
// `--password <p>` and `--password=<p>` are refused with a message that does not repeat the value.
// But a password given as a plain argument (a very common slip: `create-admin --email a@b.c
// MyPassword`) is echoed in full by the argument parser's error ("Unexpected argument
// 'MyPassword'"), which the command prints to stderr. In a container that stderr is the log
// (`docker run ... create-admin ...`, a Kubernetes Job), so the password lands in log storage
// that outlives the shell history the message warns about. The same parser error path serves
// `reset-admin`.
import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runStudioCli, type StudioCliIo } from "../../src/cli.js"

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
})

const PASSWORD = "test-only-passphrase-41"

function io() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kervan-review3-argv-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const lines: string[] = []
  const value: StudioCliIo = {
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
    env: {
      KERVAN_STUDIO_DATA_DIR: dir,
      KERVAN_STUDIO_MASTER_KEY: Buffer.alloc(32, 5).toString("base64"),
    },
    cwd: dir,
    readStdin: async () => "",
    readSecret: undefined,
  }
  return { io: value, lines }
}

describe("a password typed as an argument", () => {
  it("is refused without being printed back: --password=<p>", async () => {
    const { io: value, lines } = io()
    const code = await runStudioCli(
      ["create-admin", "--email", "a@example.test", `--password=${PASSWORD}`],
      value,
    )
    expect(code).toBe(1)
    expect(lines.join("\n")).not.toContain(PASSWORD)
  })

  it("is refused without being printed back: a plain positional argument (create-admin)", async () => {
    const { io: value, lines } = io()
    const code = await runStudioCli(["create-admin", "--email", "a@example.test", PASSWORD], value)
    expect(code).toBe(1)
    expect(lines.join("\n")).not.toContain(PASSWORD)
  })

  it("is refused without being printed back: a plain positional argument (reset-admin)", async () => {
    const { io: value, lines } = io()
    const code = await runStudioCli(["reset-admin", "--email", "a@example.test", PASSWORD], value)
    expect(code).toBe(1)
    expect(lines.join("\n")).not.toContain(PASSWORD)
  })
})
