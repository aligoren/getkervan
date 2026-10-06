import { FORBIDDEN } from "@kervan/core"
import { afterEach, describe, expect, it } from "vitest"
import { hashPassword, passwordProblem, verifyPassword } from "../src/crypto.js"
import { createWorkspace } from "../src/db/repos/workspaces.js"
import { studioLogger } from "../src/logger.js"
import { addressRangeProblem, METADATA_ADDRESSES, studioNetworkPolicy } from "../src/network.js"
import { InMemorySecretStore, normalizeAllowedHosts, SecretInputError } from "../src/secrets.js"
import { echoTool, publishedServer, spec, startTestStudio, type TestStudio } from "./helpers.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe("secret store bindings", () => {
  const scope = { workspaceId: "w" } as Parameters<InMemorySecretStore["source"]>[0]
  const value = "a-long-enough-value"

  it("answers only for an allowed host, matched exactly", async () => {
    const store = new InMemorySecretStore()
    store.set(scope, "s", { name: "KEY", value, allowedHosts: ["API.example.com"] })
    const source = store.source(scope, "s")
    expect(await source.get("KEY", { host: "api.example.com", tool: "t" })).toBe(value)
    for (const host of ["example.com", "x.api.example.com", "api.example.com.evil.test"]) {
      expect(await source.get("KEY", { host, tool: "t" }), host).toBeUndefined()
    }
  })

  it("answers nothing without a host to check", async () => {
    const store = new InMemorySecretStore()
    store.set(scope, "s", { name: "KEY", value, allowedHosts: ["api.example.com"] })
    expect(await store.source(scope, "s").get("KEY")).toBeUndefined()
  })

  it("keeps servers and workspaces apart", async () => {
    const store = new InMemorySecretStore()
    store.set(scope, "s", { name: "KEY", value, allowedHosts: ["api.example.com"] })
    const context = { host: "api.example.com", tool: "t" }
    expect(await store.source(scope, "other").get("KEY", context)).toBeUndefined()
    const otherScope = { workspaceId: "w2" } as typeof scope
    expect(await store.source(otherScope, "s").get("KEY", context)).toBeUndefined()
    expect(await store.list(otherScope, "s")).toEqual([])
  })

  it.each([
    [[], /at least one allowed host/],
    [["*.example.com"], /not a host name/],
    [["https://api.example.com"], /not a host name/],
    [["api.example.com:443"], /not a host name/],
    [["api.example.com/v1"], /not a host name/],
    [[""], /not a host name/],
  ])("refuses allowed hosts %j", (hosts, message) => {
    expect(() => normalizeAllowedHosts(hosts)).toThrow(message)
  })

  it("checks names and value lengths, and never echoes the value", () => {
    const store = new InMemorySecretStore()
    const set = (name: string, secret: string) =>
      store.set(scope, "s", { name, value: secret, allowedHosts: ["a.example.com"] })
    expect(() => set("lower", value)).toThrow(SecretInputError)
    const error = (() => {
      try {
        set("KEY", "short")
      } catch (e) {
        return e as Error
      }
    })()
    expect(error?.message).toMatch(/at least 8 characters/)
    expect(error?.message).not.toContain("short")
  })

  it("lists bindings without values", async () => {
    const store = new InMemorySecretStore()
    store.set(scope, "s", { name: "KEY", value, allowedHosts: ["a.example.com"] }, 5)
    expect(await store.list(scope, "s")).toEqual([
      { name: "KEY", allowedHosts: ["a.example.com"], updatedAt: 5 },
    ])
  })
})

describe("Studio's logger", () => {
  it("redacts known secrets from messages and from serialized data, errors included", () => {
    const lines: string[] = []
    const logger = studioLogger((text) => text.replaceAll("hunter2-secret", "[redacted]"), {
      write: (line) => lines.push(line),
    })
    logger.error("call failed for hunter2-secret", new Error("upstream said hunter2-secret"))
    logger.warn("data", { nested: { value: "hunter2-secret" } })
    logger.debug("hidden by level")
    expect(lines).toHaveLength(2)
    expect(lines.join("\n")).not.toContain("hunter2-secret")
    expect(lines.join("\n")).toContain("[redacted]")
  })
})

describe("network policy", () => {
  it("always refuses metadata addresses and never allows private ones", () => {
    const policy = studioNetworkPolicy({
      denyList: ["192.0.2.0/24"],
      allowPrivate: ["0.0.0.0/0"],
    } as Parameters<typeof studioNetworkPolicy>[0])
    expect(policy.denyList).toEqual(expect.arrayContaining([...METADATA_ADDRESSES, "192.0.2.0/24"]))
    expect(policy).not.toHaveProperty("allowPrivate")
  })
})

describe("deny list entries", () => {
  it.each(["10.0.0.0/8", "192.0.2.1", "fd00::/8", "2001:db8::1", "0.0.0.0/0"])(
    "accepts %s",
    (entry) => {
      expect(addressRangeProblem(entry)).toBeUndefined()
    },
  )

  it.each(["internal.example.corp", "10.0.0.0/33", "fd00::/129", "10.0.0.0/x", "1.2.3.4/8/1", ""])(
    "refuses %j",
    (entry) => {
      expect(addressRangeProblem(entry)).toBeDefined()
    },
  )
})

describe("passwords", () => {
  it("hashes with scrypt and verifies only the right password", async () => {
    const hash = await hashPassword("correct horse battery")
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/)
    expect(hash).not.toContain("correct horse battery")
    expect(await verifyPassword("correct horse battery", hash)).toBe(true)
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false)
    expect(await verifyPassword("x", "not-a-hash")).toBe(false)
    expect(passwordProblem("short")).toMatch(/at least 12/)
  })
})

describe("gateway resolution", () => {
  async function studio(): Promise<TestStudio> {
    const t = await startTestStudio()
    cleanups.push(t.close)
    return t
  }

  it("refuses auth info whose server is not the one in the URL, on its own", async () => {
    // Authentication already refuses this; resolution must refuse it too.
    const t = await studio()
    const one = await publishedServer(t, spec(echoTool("https://x.test/")), { slug: "one" })
    const other = createWorkspace(t.database.db, "other")
    const auth = (workspaceId: string, serverId: string) => ({
      token: "k",
      clientId: "k",
      scopes: [],
      extra: { workspaceId, serverId },
    })
    const gateway = t.studio.gateway
    const ws = one.scope.workspaceId
    expect(await gateway.resolve(auth(ws, one.server.id), { serverId: "else" })).toBe(FORBIDDEN)
    expect(await gateway.resolve(undefined, { serverId: one.server.id })).toBe(FORBIDDEN)
    // The right server id with the wrong workspace finds nothing.
    expect(
      await gateway.resolve(auth(other.workspaceId, one.server.id), { serverId: one.server.id }),
    ).toBeNull()
    expect(await gateway.resolve(auth(ws, one.server.id), { serverId: one.server.id })).not.toBe(
      FORBIDDEN,
    )
  })
})
