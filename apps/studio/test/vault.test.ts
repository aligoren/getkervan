import { mkdtempSync, rmSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runStudioCli } from "../src/cli.js"
import { loadConfig } from "../src/config.js"
import { openDatabase } from "../src/db/open.js"
import { createServer } from "../src/db/repos/servers.js"
import { createWorkspace, defaultWorkspace } from "../src/db/repos/workspaces.js"
import { secrets as secretsTable } from "../src/db/schema.js"
import { envKeyProvider, KeyError, staticKeyProvider } from "../src/keys.js"
import { DATABASE_FILE, startStudio } from "../src/server.js"
import { DbSecretStore, VaultError } from "../src/vault.js"

const VALUE = "vault-secret-value-0123456789"
const KEY_A = Buffer.alloc(32, 1)
const KEY_B = Buffer.alloc(32, 2)
const keysA = staticKeyProvider({ version: 1, key: KEY_A })

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function memoryVault(keys = keysA) {
  const database = openDatabase(":memory:")
  cleanups.push(() => database.close())
  const scope = createWorkspace(database.db, "w")
  const server = createServer(database.db, scope, { slug: "s", name: "S" })
  return { database, scope, server, vault: new DbSecretStore(database.db, keys) }
}

const host = { host: "api.example.com:443", tool: "t" }

describe("the encrypted vault", () => {
  it("stores only ciphertext, with a fresh IV per write, and never lists values", async () => {
    const { database, scope, server, vault } = memoryVault()
    const put = await vault.put(scope, server.id, {
      name: "API_KEY",
      value: VALUE,
      allowedHosts: ["api.example.com"],
    })
    expect(JSON.stringify(put)).not.toContain(VALUE)
    const first = database.db.select().from(secretsTable).get()
    await vault.put(scope, server.id, {
      name: "API_KEY",
      value: VALUE,
      allowedHosts: ["api.example.com"],
    })
    const second = database.db.select().from(secretsTable).get()
    const dump = JSON.stringify(database.sqlite.prepare("SELECT * FROM secrets").all())
    expect(dump).not.toContain(VALUE)
    expect(dump).not.toContain(Buffer.from(VALUE).toString("hex"))
    expect(first?.iv.equals(second?.iv ?? Buffer.alloc(0))).toBe(false)
    expect(JSON.stringify(await vault.list(scope, server.id))).not.toContain(VALUE)
    expect(await vault.source(scope, server.id).get("API_KEY", host)).toBe(VALUE)
  })

  it("answers only for an allowed host:port, and nothing without a context", async () => {
    const { scope, server, vault } = memoryVault()
    await vault.put(scope, server.id, {
      name: "API_KEY",
      value: VALUE,
      allowedHosts: ["api.example.com"],
    })
    const source = vault.source(scope, server.id)
    expect(await source.get("API_KEY")).toBeUndefined()
    expect(await source.get("API_KEY", { host: "api.example.com:8443", tool: "t" })).toBeUndefined()
    expect(await source.get("API_KEY", { host: "evil.example.com:443", tool: "t" })).toBeUndefined()
    expect(await vault.source(scope, "another-server").get("API_KEY", host)).toBeUndefined()
  })

  it("changes hosts without a value, and refuses a new secret without one", async () => {
    const { scope, server, vault } = memoryVault()
    await expect(
      vault.put(scope, server.id, { name: "NEW_KEY", allowedHosts: ["api.example.com"] }),
    ).rejects.toThrow(/needs a value/)
    await vault.put(scope, server.id, {
      name: "API_KEY",
      value: VALUE,
      allowedHosts: ["a.example.com"],
    })
    const moved = await vault.put(scope, server.id, {
      name: "API_KEY",
      allowedHosts: ["b.example.com"],
    })
    expect(moved).toMatchObject({ created: false, rotated: false })
    const source = vault.source(scope, server.id)
    expect(await source.get("API_KEY", { host: "b.example.com:443", tool: "t" })).toBe(VALUE)
    expect(await source.get("API_KEY", { host: "a.example.com:443", tool: "t" })).toBeUndefined()
  })

  it("binds each ciphertext to its row: a copied ciphertext does not decrypt", async () => {
    const { database, scope, server, vault } = memoryVault()
    const other = createServer(database.db, scope, { slug: "o", name: "O" })
    await vault.put(scope, server.id, {
      name: "API_KEY",
      value: VALUE,
      allowedHosts: ["api.example.com"],
    })
    await vault.put(scope, other.id, {
      name: "API_KEY",
      value: "other-value-0123456",
      allowedHosts: ["api.example.com"],
    })
    // Someone with database access copies server A's ciphertext into server B's row.
    database.sqlite
      .prepare(
        `UPDATE secrets SET ciphertext = (SELECT ciphertext FROM secrets WHERE server_id = ?),
         iv = (SELECT iv FROM secrets WHERE server_id = ?), tag = (SELECT tag FROM secrets WHERE server_id = ?)
         WHERE server_id = ?`,
      )
      .run(server.id, server.id, server.id, other.id)
    await expect(vault.source(scope, other.id).get("API_KEY", host)).rejects.toThrow()
    expect(() => vault.verifyAndRewrap()).toThrow(VaultError)
  })

  it("refuses to work with the wrong master key", async () => {
    const { database, scope, server, vault } = memoryVault()
    await vault.put(scope, server.id, {
      name: "API_KEY",
      value: VALUE,
      allowedHosts: ["api.example.com"],
    })
    const wrong = new DbSecretStore(database.db, staticKeyProvider({ version: 1, key: KEY_B }))
    expect(() => wrong.verifyAndRewrap()).toThrow(
      /cannot be decrypted with the configured master keys/,
    )
    await expect(wrong.source(scope, server.id).get("API_KEY", host)).rejects.toThrow()
  })

  it("re-encrypts old rows when the master key is rotated", async () => {
    const { database, scope, server, vault } = memoryVault()
    await vault.put(scope, server.id, {
      name: "API_KEY",
      value: VALUE,
      allowedHosts: ["api.example.com"],
    })
    const rotated = new DbSecretStore(
      database.db,
      staticKeyProvider({ version: 2, key: KEY_B }, new Map([[1, KEY_A]])),
    )
    expect(rotated.verifyAndRewrap()).toBe(1)
    expect(database.db.select().from(secretsTable).get()?.keyVersion).toBe(2)
    // The old key is no longer needed.
    const onlyNew = new DbSecretStore(database.db, staticKeyProvider({ version: 2, key: KEY_B }))
    expect(onlyNew.verifyAndRewrap()).toBe(0)
    expect(await onlyNew.source(scope, server.id).get("API_KEY", host)).toBe(VALUE)
  })
})

describe("master keys from the environment", () => {
  const b64 = (key: Buffer) => key.toString("base64")

  it("reads a current key with an optional version, and previous keys", () => {
    const plain = envKeyProvider({ KERVAN_STUDIO_MASTER_KEY: b64(KEY_A) })
    expect(plain.current().version).toBe(1)
    const rotated = envKeyProvider({
      KERVAN_STUDIO_MASTER_KEY: `3:${b64(KEY_B)}`,
      KERVAN_STUDIO_PREVIOUS_MASTER_KEYS: `1:${b64(KEY_A)}, 2:${KEY_A.toString("base64url")}`,
    })
    expect(rotated.current()).toEqual({ version: 3, key: KEY_B })
    expect(rotated.get(1)).toEqual(KEY_A)
    expect(rotated.get(2)).toEqual(KEY_A)
  })

  it.each([
    [{}, /KERVAN_STUDIO_MASTER_KEY is not set/],
    [{ KERVAN_STUDIO_MASTER_KEY: "short" }, /exactly 32 bytes/],
    [{ KERVAN_STUDIO_MASTER_KEY: "not base64!" }, /base64/],
    [
      { KERVAN_STUDIO_MASTER_KEY: b64(KEY_A), KERVAN_STUDIO_PREVIOUS_MASTER_KEYS: b64(KEY_B) },
      /with a version/,
    ],
    [
      {
        KERVAN_STUDIO_MASTER_KEY: `1:${b64(KEY_A)}`,
        KERVAN_STUDIO_PREVIOUS_MASTER_KEYS: `1:${b64(KEY_B)}`,
      },
      /given twice/,
    ],
  ])("refuses %j", (env, message) => {
    expect(() => envKeyProvider(env)).toThrow(KeyError)
    expect(() => envKeyProvider(env)).toThrow(message)
  })

  it("does not start Studio without a key, or with a key that does not fit the data", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kervan-vault-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const err: string[] = []
    const io = {
      out: () => {},
      err: (line: string) => err.push(line),
      env: { KERVAN_STUDIO_DATA_DIR: dir, KERVAN_STUDIO_PORT: "0" },
      cwd: dir,
      readStdin: async () => "",
    }
    expect(await runStudioCli(["start"], io)).toBe(1)
    expect(err.join("\n")).toMatch(/KERVAN_STUDIO_MASTER_KEY is not set/)

    // Store a secret under key A, then try to start with key B.
    const database = openDatabase(path.join(dir, DATABASE_FILE))
    const scope = defaultWorkspace(database.db)
    const server = createServer(database.db, scope, { slug: "s", name: "S" })
    await new DbSecretStore(database.db, keysA).put(scope, server.id, {
      name: "API_KEY",
      value: VALUE,
      allowedHosts: ["api.example.com"],
    })
    database.close()
    await expect(
      startStudio(loadConfig({ KERVAN_STUDIO_DATA_DIR: dir, KERVAN_STUDIO_PORT: "0" }), {
        print: () => {},
        resolveSelf: async () => [],
        keys: staticKeyProvider({ version: 1, key: KEY_B }),
      }),
    ).rejects.toThrow(VaultError)
  })
})
