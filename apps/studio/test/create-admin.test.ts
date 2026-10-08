// `kervan-studio create-admin`: the first admin from the operator's shell, for a container where
// the loopback-only setup page cannot be reached. The password never comes from an argument or
// the environment; the checks are the setup page's; a running Studio and the command cannot both
// create an admin.
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { type AddressInfo, createServer as createNetServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { createFirstAdmin } from "../src/accounts.js"
import { runStudioCli, type StudioCliIo } from "../src/cli.js"
import { loadConfig } from "../src/config.js"
import { hashPassword, verifyPassword } from "../src/crypto.js"
import { openDatabase } from "../src/db/open.js"
import { listAudit } from "../src/db/repos/audit.js"
import { createServer } from "../src/db/repos/servers.js"
import { consumeSetupToken, issueSetupToken, setupTokenValid } from "../src/db/repos/tokens.js"
import { createUser, listUsers } from "../src/db/repos/users.js"
import { defaultWorkspace } from "../src/db/repos/workspaces.js"
import { staticKeyProvider } from "../src/keys.js"
import { DATABASE_FILE, startStudio } from "../src/server.js"
import { StudioError } from "../src/studio.js"
import { InputCancelled } from "../src/tty.js"
import { DbSecretStore } from "../src/vault.js"

const BIN = fileURLToPath(new URL("../bin/kervan-studio.js", import.meta.url))
/** A fixed test master key (never use a constant key outside tests). */
const KEY = Buffer.alloc(32, 7)
const KEYS = staticKeyProvider({ version: 1, key: KEY })
const PASSWORD = "a long admin passphrase 1"

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function dataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kervan-create-admin-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function env(dir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    KERVAN_STUDIO_DATA_DIR: dir,
    KERVAN_STUDIO_MASTER_KEY: KEY.toString("base64"),
    ...extra,
  }
}

/** The command line's IO, recording everything; no terminal unless `readSecret` is given. */
function io(
  dir: string,
  options: {
    stdin?: string
    env?: NodeJS.ProcessEnv
    readSecret?: (prompt: string) => Promise<string>
  } = {},
) {
  const out: string[] = []
  const err: string[] = []
  let stdinReads = 0
  const value: StudioCliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    env: options.env ?? env(dir),
    cwd: dir,
    readStdin: async () => {
      stdinReads++
      return options.stdin ?? ""
    },
    readSecret: options.readSecret,
  }
  return { io: value, out, err, stdinReads: () => stdinReads }
}

async function withDatabase<T>(
  dir: string,
  fn: (
    db: ReturnType<typeof openDatabase>["db"],
    sqlite: ReturnType<typeof openDatabase>["sqlite"],
  ) => T | Promise<T>,
): Promise<T> {
  const database = openDatabase(path.join(dir, DATABASE_FILE))
  try {
    return await fn(database.db, database.sqlite)
  } finally {
    database.close()
  }
}

const users = (dir: string) => withDatabase(dir, (db) => listUsers(db, defaultWorkspace(db)))

describe("kervan-studio create-admin", () => {
  it("creates the first admin from stdin, records it, and retires the setup token", async () => {
    const dir = dataDir()
    const token = await withDatabase(dir, (db) => issueSetupToken(db).token)
    const cli = io(dir, { stdin: `${PASSWORD}\n` })
    const code = await runStudioCli(
      ["create-admin", "--email", " Admin@Example.TEST ", "--password-stdin"],
      cli.io,
    )
    expect(cli.err).toEqual([])
    expect(code).toBe(0)
    expect(cli.out.join("\n")).toContain("Created the admin admin@example.test")
    expect(cli.out.join("\n")).toContain("setup token Studio printed no longer works")

    await withDatabase(dir, async (db, sqlite) => {
      const scope = defaultWorkspace(db)
      const [admin, ...others] = listUsers(db, scope)
      expect(others).toEqual([])
      expect(admin).toMatchObject({
        email: "admin@example.test",
        role: "admin",
        disabledAt: null,
        mustChangePassword: false,
      })
      // The password the operator chose works; nothing was generated.
      const row = sqlite
        .prepare("SELECT password_hash AS hash FROM users WHERE id = ?")
        .get(admin?.id) as { hash: string }
      expect(await verifyPassword(PASSWORD, row.hash)).toBe(true)

      const events = listAudit(db, scope)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        action: "studio.setup",
        actorType: "cli",
        targetId: admin?.id,
        details: { command: "create-admin", setupTokensRetired: 1 },
      })
      // Neither the password nor the setup token is anywhere: audit, users or output.
      const everything = JSON.stringify({
        audit: sqlite.prepare("SELECT * FROM audit_events").all(),
        users: sqlite.prepare("SELECT * FROM users").all(),
        out: cli.out,
      })
      expect(everything).not.toContain(PASSWORD)
      expect(everything).not.toContain(token)

      expect(setupTokenValid(db, token)).toBe(false)
      expect(consumeSetupToken(db, token)).toBe(false)
    })
  })

  it("refuses once an admin exists, before asking for a password", async () => {
    const dir = dataDir()
    await withDatabase(dir, async (db) => {
      const passwordHash = await hashPassword("the existing admin 1")
      createUser(db, defaultWorkspace(db), {
        email: "first@example.test",
        passwordHash,
        role: "admin",
      })
    })
    const asked: string[] = []
    const cli = io(dir, {
      stdin: `${PASSWORD}\n`,
      readSecret: async (prompt) => {
        asked.push(prompt)
        return PASSWORD
      },
    })
    expect(await runStudioCli(["create-admin", "--email", "second@example.test"], cli.io)).toBe(1)
    expect(cli.err.join("\n")).toMatch(/already has an admin/)
    expect(cli.err.join("\n")).toMatch(/reset-admin/)
    expect(asked).toEqual([])
    const piped = io(dir, { stdin: `${PASSWORD}\n` })
    expect(
      await runStudioCli(
        ["create-admin", "--email", "second@example.test", "--password-stdin"],
        piped.io,
      ),
    ).toBe(1)
    expect(piped.stdinReads()).toBe(0)
    expect((await users(dir)).map((user) => user.email)).toEqual(["first@example.test"])
  })

  it("checks again when writing: an admin made meanwhile wins", async () => {
    const dir = dataDir()
    const database = openDatabase(path.join(dir, DATABASE_FILE))
    cleanups.push(() => database.close())
    const other = openDatabase(path.join(dir, DATABASE_FILE))
    cleanups.push(() => other.close())
    const earlyHash = await hashPassword("the early admin 12")
    // The first check passes; while the password is hashed, another connection (a running
    // Studio's setup) creates an admin.
    const creating = createFirstAdmin(database.db, {
      email: "late@example.test",
      password: PASSWORD,
    })
    createUser(other.db, defaultWorkspace(other.db), {
      email: "early@example.test",
      passwordHash: earlyHash,
      role: "admin",
    })
    const error = await creating.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(StudioError)
    expect((error as StudioError).message).toBe("Studio is already set up.")
    expect(listUsers(database.db, defaultWorkspace(database.db)).map((u) => u.email)).toEqual([
      "early@example.test",
    ])
  })

  describe("never takes the password from an argument or the environment", () => {
    for (const args of [
      ["--password", PASSWORD],
      [`--password=${PASSWORD}`],
      ["--password-stdin", "--password", PASSWORD],
    ]) {
      it(`refuses ${args[0]}`, async () => {
        const dir = dataDir()
        const cli = io(dir, { stdin: `${PASSWORD}\n` })
        expect(
          await runStudioCli(["create-admin", "--email", "a@example.test", ...args], cli.io),
        ).toBe(1)
        expect(cli.err.join("\n")).toMatch(/does not take the password as an argument/)
        expect(cli.err.join("\n")).not.toContain(PASSWORD)
        expect(await users(dir)).toEqual([])
      })
    }

    it("refuses a password given as a plain argument", async () => {
      const dir = dataDir()
      const cli = io(dir)
      expect(
        await runStudioCli(["create-admin", "--email", "a@example.test", PASSWORD], cli.io),
      ).toBe(1)
      expect(await users(dir)).toEqual([])
    })

    it("never repeats what was typed in an error (an unknown option or command)", async () => {
      const dir = dataDir()
      for (const args of [
        ["create-admin", "--email", "a@example.test", `--${PASSWORD.replaceAll(" ", "-")}`],
        ["create-admin", "--email", "a@example.test", "--password-stdin=yes"],
        [PASSWORD],
        ["Hunter2-Passphrase!"],
      ]) {
        const cli = io(dir)
        expect(await runStudioCli(args, cli.io), args.join(" ")).toBe(1)
        const said = cli.err.join("\n")
        expect(said).not.toContain(PASSWORD.replaceAll(" ", "-"))
        expect(said).not.toContain(PASSWORD)
        expect(said).not.toContain("Hunter2")
      }
      const typo = io(dir)
      expect(await runStudioCli(["create-amdin"], typo.io)).toBe(1)
      expect(typo.err.join("\n")).toContain('Unknown command "create-amdin"')
      expect(await users(dir)).toEqual([])
    })

    it("ignores password-like environment variables and asks for a terminal", async () => {
      const dir = dataDir()
      const cli = io(dir, {
        env: env(dir, {
          KERVAN_STUDIO_ADMIN_PASSWORD: PASSWORD,
          KERVAN_STUDIO_PASSWORD: PASSWORD,
          ADMIN_PASSWORD: PASSWORD,
          PASSWORD,
        }),
      })
      expect(await runStudioCli(["create-admin", "--email", "a@example.test"], cli.io)).toBe(1)
      expect(cli.err.join("\n")).toMatch(/No terminal to type the password in/)
      expect(cli.err.join("\n")).toMatch(/--password-stdin/)
      expect(await users(dir)).toEqual([])
    })
  })

  describe("in a terminal", () => {
    it("asks twice, hidden, and shows the password nowhere", async () => {
      const dir = dataDir()
      const prompts: string[] = []
      const cli = io(dir, {
        readSecret: async (prompt) => {
          prompts.push(prompt)
          return PASSWORD
        },
      })
      expect(await runStudioCli(["create-admin", "--email", "t@example.test"], cli.io)).toBe(0)
      expect(prompts).toEqual(["Password for t@example.test: ", "Type it again: "])
      expect([...cli.out, ...cli.err].join("\n")).not.toContain(PASSWORD)
      expect((await users(dir)).map((user) => user.role)).toEqual(["admin"])
    })

    it("changes nothing when the two do not match, or when cancelled", async () => {
      const dir = dataDir()
      const answers = [PASSWORD, `${PASSWORD}x`]
      const mismatch = io(dir, { readSecret: async () => answers.shift() ?? "" })
      expect(await runStudioCli(["create-admin", "--email", "t@example.test"], mismatch.io)).toBe(1)
      expect(mismatch.err.join("\n")).toMatch(/do not match/)
      const cancelled = io(dir, {
        readSecret: async () => {
          throw new InputCancelled("Cancelled.")
        },
      })
      expect(await runStudioCli(["create-admin", "--email", "t@example.test"], cancelled.io)).toBe(
        1,
      )
      expect(cancelled.err.join("\n")).toMatch(/Cancelled; nothing was changed/)
      expect(await users(dir)).toEqual([])
    })
  })

  describe("checks the email and the password like the setup page", () => {
    const rlo = String.fromCodePoint(0x202e)
    for (const [label, email, password, message] of [
      ["no email", undefined, PASSWORD, /Give the admin's email/],
      ["an invalid email", "not-an-email", PASSWORD, /valid email/],
      ["an email with hidden characters", `admin${rlo}@example.test`, PASSWORD, /U\+202E/],
      ["a short password", "a@example.test", "too short", /at least 12 characters/],
      ["a password too long", "a@example.test", "x".repeat(1025), /at most 1024/],
    ] as const) {
      it(`refuses ${label}`, async () => {
        const dir = dataDir()
        const cli = io(dir, { stdin: `${password}\n` })
        const args = ["create-admin", ...(email ? ["--email", email] : []), "--password-stdin"]
        expect(await runStudioCli(args, cli.io)).toBe(1)
        expect(cli.err.join("\n")).toMatch(message)
        expect(await users(dir)).toEqual([])
      })
    }
  })

  describe("finds the data directory and the master key like a start", () => {
    async function withSecret(dir: string) {
      await withDatabase(dir, async (db) => {
        const scope = defaultWorkspace(db)
        const server = createServer(db, scope, { slug: "s", name: "S" })
        await new DbSecretStore(db, KEYS).put(scope, server.id, {
          name: "API_KEY",
          value: "a-long-enough-value",
          allowedHosts: ["api.example.com"],
        })
      })
    }

    it("needs the master key", async () => {
      const dir = dataDir()
      const cli = io(dir, { stdin: `${PASSWORD}\n`, env: { KERVAN_STUDIO_DATA_DIR: dir } })
      expect(
        await runStudioCli(
          ["create-admin", "--email", "a@example.test", "--password-stdin"],
          cli.io,
        ),
      ).toBe(1)
      expect(cli.err.join("\n")).toMatch(/KERVAN_STUDIO_MASTER_KEY is not set/)
      expect(await users(dir)).toEqual([])
    })

    it("says not to make a new key when the data directory holds secrets", async () => {
      const dir = dataDir()
      await withSecret(dir)
      const cli = io(dir, { stdin: `${PASSWORD}\n`, env: { KERVAN_STUDIO_DATA_DIR: dir } })
      expect(
        await runStudioCli(
          ["create-admin", "--email", "a@example.test", "--password-stdin"],
          cli.io,
        ),
      ).toBe(1)
      expect(cli.err.join("\n")).toMatch(/already holds 1 encrypted secret/)
    })

    it("refuses a key that does not decrypt the stored secrets, and re-encrypts nothing", async () => {
      const dir = dataDir()
      await withSecret(dir)
      const before = await withDatabase(dir, (_db, sqlite) =>
        sqlite.prepare("SELECT ciphertext FROM secrets").all(),
      )
      const wrong = io(dir, {
        stdin: `${PASSWORD}\n`,
        env: { ...env(dir), KERVAN_STUDIO_MASTER_KEY: Buffer.alloc(32, 8).toString("base64") },
      })
      expect(
        await runStudioCli(
          ["create-admin", "--email", "a@example.test", "--password-stdin"],
          wrong.io,
        ),
      ).toBe(1)
      expect(wrong.err.join("\n")).toMatch(/cannot be decrypted/)
      // A newer key version with the old one as previous: valid, but nothing is rewritten here
      // (re-encryption is Studio's job at start).
      const rotated = io(dir, {
        stdin: `${PASSWORD}\n`,
        env: {
          ...env(dir),
          KERVAN_STUDIO_MASTER_KEY: `2:${Buffer.alloc(32, 8).toString("base64")}`,
          KERVAN_STUDIO_PREVIOUS_MASTER_KEYS: `1:${KEY.toString("base64")}`,
        },
      })
      expect(
        await runStudioCli(
          ["create-admin", "--email", "a@example.test", "--password-stdin"],
          rotated.io,
        ),
      ).toBe(0)
      const after = await withDatabase(dir, (_db, sqlite) =>
        sqlite.prepare("SELECT ciphertext FROM secrets").all(),
      )
      expect(after).toEqual(before)
    })

    it("uses KERVAN_STUDIO_DATA_DIR relative to the working directory", async () => {
      const dir = dataDir()
      const cli = io(dir, {
        stdin: `${PASSWORD}\n`,
        env: env("nested-data"),
      })
      expect(
        await runStudioCli(
          ["create-admin", "--email", "a@example.test", "--password-stdin"],
          cli.io,
        ),
      ).toBe(0)
      expect(await users(path.join(dir, "nested-data"))).toHaveLength(1)
    })
  })
})

describe("create-admin next to a running Studio (real processes)", () => {
  async function freePort(): Promise<number> {
    return new Promise<number>((resolve) => {
      const probe = createNetServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo
        probe.close(() => resolve(port))
      })
    })
  }

  /** Runs the real `kervan-studio` command in a new process. */
  function runBin(args: string[], childEnv: NodeJS.ProcessEnv, stdin: string) {
    const base = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("KERVAN_")),
    )
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...base, ...childEnv },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.stdin.end(stdin)
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      child.on("close", (code) => resolve({ code, stdout, stderr }))
    })
  }

  async function startOn(dir: string, host: string) {
    const port = await freePort()
    const lines: string[] = []
    const running = await startStudio(
      loadConfig({
        KERVAN_STUDIO_DATA_DIR: dir,
        KERVAN_STUDIO_PORT: String(port),
        KERVAN_STUDIO_HOST: host,
      }),
      { print: (line) => lines.push(line), resolveSelf: async () => [], keys: KEYS },
    )
    cleanups.push(running.close)
    return { running, lines, port, origin: `http://127.0.0.1:${port}` }
  }

  // Starts Studio's server, database driver and spec runtime in a child: slow under a busy run.
  it("the running Studio moves to its host, and its setup token no longer works", {
    timeout: 60_000,
  }, async () => {
    const dir = dataDir()
    const { running, lines, port, origin } = await startOn(dir, "::1")
    expect(running.boundHost).toBe("127.0.0.1")
    const token = running.setupToken ?? ""

    const created = await runBin(
      ["create-admin", "--email", "ops@example.test", "--password-stdin"],
      env(dir),
      `${PASSWORD}\n`,
    )
    expect(created.stderr).toBe("")
    expect(created.code).toBe(0)
    expect(`${created.stdout}${created.stderr}`).not.toContain(PASSWORD)

    await expect
      .poll(() => lines.join("\n"), { timeout: 10_000 })
      .toMatch(/now listening on ::1|Could not/)
    expect(lines.join("\n")).toContain("An admin was created from the command line.")
    expect(lines.join("\n")).toContain("now listening on ::1")

    const base = `http://[::1]:${port}`
    expect(await (await fetch(`${base}/api/setup`)).json()).toEqual({ needed: false })
    const setup = await fetch(`${base}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ token, email: "intruder@example.test", password: PASSWORD }),
    })
    expect(setup.status).toBe(409)
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "ops@example.test", password: PASSWORD }),
    })
    expect(login.status).toBe(200)
    expect(setupTokenValid(running.database.db, token)).toBe(false)
    const setupEvents = listAudit(running.database.db, defaultWorkspace(running.database.db), {
      action: "studio.setup",
    })
    expect(setupEvents.map((event) => event.actorType)).toEqual(["cli"])

    // A second run is refused: the first admin exists.
    const again = await runBin(
      ["create-admin", "--email", "other@example.test", "--password-stdin"],
      env(dir),
      `${PASSWORD}\n`,
    )
    expect(again.code).toBe(1)
    expect(again.stderr).toMatch(/already has an admin/)
  })

  it("a setup in the browser and create-admin at once make exactly one admin", {
    timeout: 60_000,
  }, async () => {
    const dir = dataDir()
    const { running, origin } = await startOn(dir, "127.0.0.1")
    const [cli, setup] = await Promise.all([
      runBin(
        ["create-admin", "--email", "cli@example.test", "--password-stdin"],
        env(dir),
        `${PASSWORD}\n`,
      ),
      fetch(`${origin}/api/setup`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({
          token: running.setupToken,
          email: "web@example.test",
          password: PASSWORD,
        }),
      }),
    ])
    const admins = listUsers(running.database.db, defaultWorkspace(running.database.db))
    expect(admins).toHaveLength(1)
    if (cli.code === 0) {
      expect(admins[0]?.email).toBe("cli@example.test")
      // Refused as already set up, or because the token was retired first.
      expect([403, 409]).toContain(setup.status)
    } else {
      expect(cli.code).toBe(1)
      expect(cli.stderr).toMatch(/already has an admin/)
      expect(setup.status).toBe(201)
      expect(admins[0]?.email).toBe("web@example.test")
    }
  })
})
