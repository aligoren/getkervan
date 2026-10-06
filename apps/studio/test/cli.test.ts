import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { runStudioCli, type StudioCliIo } from "../src/cli.js"
import { loadConfig } from "../src/config.js"
import { hashPassword, verifyPassword } from "../src/crypto.js"
import { openDatabase } from "../src/db/open.js"
import { listAudit } from "../src/db/repos/audit.js"
import { consumeSetupToken } from "../src/db/repos/tokens.js"
import { createUser, findUserByEmail } from "../src/db/repos/users.js"
import { defaultWorkspace } from "../src/db/repos/workspaces.js"
import { sessions } from "../src/db/schema.js"
import { InMemorySecretStore } from "../src/secrets.js"
import { DATABASE_FILE, startStudio } from "../src/server.js"
import { StudioError } from "../src/studio.js"
import {
  connect,
  echoTool,
  resultText,
  spec,
  startUpstream,
  type Upstream,
  user,
} from "./helpers.js"

let upstream: Upstream
beforeAll(async () => {
  upstream = await startUpstream()
})
afterAll(() => upstream.close())

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function dataDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "kervan-studio-cli-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function start(env: NodeJS.ProcessEnv, options: Parameters<typeof startStudio>[1] = {}) {
  const lines: string[] = []
  const running = await startStudio(loadConfig({ KERVAN_STUDIO_PORT: "0", ...env }), {
    print: (line) => lines.push(line),
    resolveSelf: async () => [],
    ...options,
  })
  cleanups.push(running.close)
  return { running, lines }
}

async function withDatabase<T>(
  dir: string,
  fn: (db: ReturnType<typeof openDatabase>["db"]) => T | Promise<T>,
): Promise<T> {
  const database = openDatabase(path.join(dir, DATABASE_FILE))
  try {
    return await fn(database.db)
  } finally {
    database.close()
  }
}

async function addAdmin(dir: string, email: string, password = "correct horse battery") {
  const passwordHash = await hashPassword(password)
  return withDatabase(dir, (db) =>
    createUser(db, defaultWorkspace(db), { email, passwordHash, role: "admin" }),
  )
}

describe("starting Studio", () => {
  it("listens on loopback only and prints a setup token until an admin exists", async () => {
    const dir = dataDir()
    const { running, lines } = await start({
      KERVAN_STUDIO_DATA_DIR: dir,
      KERVAN_STUDIO_HOST: "0.0.0.0",
      KERVAN_STUDIO_PUBLIC_URL: "https://studio.example.test",
    })
    expect(running.boundHost).toBe("127.0.0.1")
    expect(running.url.hostname).toBe("127.0.0.1")
    const token = running.setupToken
    expect(token).toBeDefined()
    const output = lines.join("\n")
    expect(output).toContain("listening on 127.0.0.1 only until the first admin is created")
    expect(output).toContain(`${token}`)
    expect(output).toContain("https://studio.example.test/setup")
    expect(consumeSetupToken(running.database.db, token ?? "")).toBe(true)
  })

  it("prints no setup token once an admin exists", async () => {
    const dir = dataDir()
    await addAdmin(dir, "admin@example.test")
    const { running, lines } = await start({ KERVAN_STUDIO_DATA_DIR: dir })
    expect(running.setupToken).toBeUndefined()
    expect(lines.join("\n")).not.toMatch(/setup/i)
  })

  it("drops an allowPrivate passed through the start options", async () => {
    const dir = dataDir()
    const { running } = await start(
      { KERVAN_STUDIO_DATA_DIR: dir },
      { network: { allowPrivate: ["0.0.0.0/0"] } as never },
    )
    const studio = running.studio
    const scope = defaultWorkspace(running.database.db)
    const server = studio.createServer(scope, { slug: "s", name: "S" }, user())
    const version = studio.saveVersion(
      scope,
      server.id,
      spec(echoTool(`${upstream.url}/echo/private`)),
      user(),
    )
    await studio.publish(scope, server.id, version.id, user())
    const { key } = studio.createApiKey(scope, server.id, "k", user())
    const client = await connect(new URL(`/s/${server.id}/mcp`, running.url), key)
    cleanups.push(() => client.close())
    const result = await client.callTool({ name: "echo", arguments: {} })
    expect(resultText(result)).toMatch(/disallowed address/)
    expect(upstream.requests.filter((r) => r.path === "/echo/private")).toEqual([])
  })
})

describe("Studio's own policies", () => {
  it("refuses to publish a tool that sends a secret over plain http", async () => {
    const dir = dataDir()
    const secrets = new InMemorySecretStore()
    const { running } = await start({ KERVAN_STUDIO_DATA_DIR: dir }, { secrets })
    const studio = running.studio
    const scope = defaultWorkspace(running.database.db)
    const server = studio.createServer(scope, { slug: "s", name: "S" }, user())
    secrets.set(scope, server.id, {
      name: "API_KEY",
      value: "a-long-enough-value",
      allowedHosts: ["api.example.com"],
    })
    const text = spec(
      echoTool(
        "http://api.example.com/v1",
        "keyed",
        '      headers: { X-Key: "{{secrets.API_KEY}}" }',
      ),
      "secrets: [API_KEY]",
    )
    const version = studio.saveVersion(scope, server.id, text, user())
    const error = await studio.publish(scope, server.id, version.id, user()).catch((e) => e)
    expect(error).toBeInstanceOf(StudioError)
    expect((error as StudioError).issues.map((issue) => issue.message)).toEqual([
      'Tool "keyed" uses secrets, so it must use https: Studio never sends a secret over plain http.',
    ])
    // Without secrets, plain http stays the spec author's choice.
    const plain = studio.saveVersion(
      scope,
      server.id,
      spec(echoTool("http://api.example.com/")),
      user(),
    )
    await expect(studio.publish(scope, server.id, plain.id, user())).resolves.toBeDefined()
  })

  it("refuses to start with a malformed deny list entry", async () => {
    const dir = dataDir()
    await expect(
      start({ KERVAN_STUDIO_DATA_DIR: dir, KERVAN_STUDIO_DENY_NETWORK: "10.0.0.0/8,intranet" }),
    ).rejects.toThrow(/KERVAN_STUDIO_DENY_NETWORK: "intranet" is not an IP address/)
  })
})

describe("kervan-studio reset-admin", () => {
  function io(dir: string, stdin = "") {
    const out: string[] = []
    const err: string[] = []
    const value: StudioCliIo = {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      env: { KERVAN_STUDIO_DATA_DIR: dir },
      cwd: dir,
      readStdin: async () => stdin,
    }
    return { io: value, out, err }
  }

  it("explains that there is no admin yet", async () => {
    const dir = dataDir()
    const { io: cli, err } = io(dir)
    expect(await runStudioCli(["reset-admin"], cli)).toBe(1)
    expect(err.join("\n")).toMatch(/no admin yet/)
  })

  it("sets a generated password, ends sessions and records it", async () => {
    const dir = dataDir()
    const admin = await addAdmin(dir, "admin@example.test")
    await withDatabase(dir, (db) => {
      const scope = defaultWorkspace(db)
      db.insert(sessions)
        .values({
          idHash: "h",
          workspaceId: scope.workspaceId,
          userId: admin.id,
          createdAt: 1,
          lastSeenAt: 1,
          expiresAt: Date.now() + 60_000,
        })
        .run()
    })
    const { io: cli, out } = io(dir)
    expect(await runStudioCli(["reset-admin"], cli)).toBe(0)
    const password = out.join("\n").match(/New password \(shown once\): (\S+)/)?.[1] ?? ""
    expect(password.length).toBeGreaterThanOrEqual(20)
    expect(out.join("\n")).toContain("ended 1 session(s)")
    await withDatabase(dir, async (db) => {
      const scope = defaultWorkspace(db)
      const stored = findUserByEmail(db, scope, "admin@example.test")
      expect(await verifyPassword(password, stored?.passwordHash ?? "")).toBe(true)
      expect(await verifyPassword("correct horse battery", stored?.passwordHash ?? "")).toBe(false)
      expect(db.select().from(sessions).all()).toEqual([])
      const event = listAudit(db, scope, { action: "user.password_reset" })[0]
      expect(event).toMatchObject({ actorType: "cli", targetId: admin.id })
      expect(JSON.stringify(event)).not.toContain(password)
    })
  })

  it("reads the password from stdin and checks it", async () => {
    const dir = dataDir()
    await addAdmin(dir, "admin@example.test")
    const short = io(dir, "short\n")
    expect(await runStudioCli(["reset-admin", "--password-stdin"], short.io)).toBe(1)
    expect(short.err.join("\n")).toMatch(/at least 12 characters/)
    const good = io(dir, "a much longer passphrase\n")
    expect(await runStudioCli(["reset-admin", "--password-stdin"], good.io)).toBe(0)
    expect(good.out.join("\n")).not.toContain("a much longer passphrase")
    await withDatabase(dir, async (db) => {
      const stored = findUserByEmail(db, defaultWorkspace(db), "admin@example.test")
      expect(await verifyPassword("a much longer passphrase", stored?.passwordHash ?? "")).toBe(
        true,
      )
    })
  })

  it("needs --email when there are several admins", async () => {
    const dir = dataDir()
    await addAdmin(dir, "one@example.test")
    await addAdmin(dir, "two@example.test")
    const ambiguous = io(dir)
    expect(await runStudioCli(["reset-admin"], ambiguous.io)).toBe(1)
    expect(ambiguous.err.join("\n")).toMatch(/--email/)
    const chosen = io(dir)
    expect(await runStudioCli(["reset-admin", "--email", "TWO@example.test"], chosen.io)).toBe(0)
    expect(chosen.out.join("\n")).toContain("two@example.test")
  })
})
