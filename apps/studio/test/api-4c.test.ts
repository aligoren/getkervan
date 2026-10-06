import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { listAudit } from "../src/db/repos/audit.js"
import { MAX_PAYLOAD_CHARS, purgeCalls } from "../src/db/repos/call-logs.js"
import { apiStudio, gatewayClient } from "./api-helpers.js"
import { resultText, startUpstream, type Upstream } from "./helpers.js"

const SECRET = "sk-4c-secret-value-0123456789"
const ROTATED = "sk-4c-rotated-value-9876543210"

let upstream: Upstream
beforeAll(async () => {
  upstream = await startUpstream()
})
afterAll(() => upstream.close())

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const bound = () => `bound.test:${upstream.port}`

/** A spec whose tool sends API_KEY to the bound host, which echoes it back as `key`. */
const keyedSpec = (path = "/echo/keyed", tool = "keyed") => `specVersion: 1
name: four-c
version: 1.0.0
secrets: [API_KEY]
defaults: { http: { allowInsecureHttp: true, timeoutMs: 2000 } }
tools:
  - name: ${tool}
    description: Sends the key
    input: { type: object, properties: { note: { type: string } } }
    http:
      url: http://bound.test:${upstream.port}${path}
      headers: { X-Key: "{{secrets.API_KEY}}" }
    output: { select: "@" }
`

/** A spec without secrets. */
const plainSpec = (path: string) => `specVersion: 1
name: plain
version: 1.0.0
defaults: { http: { allowInsecureHttp: true, timeoutMs: 2000 } }
tools:
  - name: plain
    description: Calls the echo API
    http: { url: "http://bound.test:${upstream.port}${path}" }
    output: { select: "@" }
`

async function setup() {
  const s = apiStudio()
  cleanups.push(s.close)
  await s.addUser("admin@example.test", "admin")
  await s.addUser("member@example.test", "member")
  const admin = await s.signIn("admin@example.test")
  const member = await s.signIn("member@example.test", undefined, "203.0.113.50")
  const server = (
    await s.request("POST", "/api/servers", { ...admin, body: { slug: "four-c", name: "4c" } })
  ).json.server as { id: string }
  const id = server.id
  const putSecret = (value: string | undefined, hosts = [bound()], who = admin) =>
    s.request("PUT", `/api/servers/${id}/secrets/API_KEY`, {
      ...who,
      body: { ...(value === undefined ? {} : { value }), allowedHosts: hosts },
    })
  const saveAndPublish = async (yaml: string) => {
    const saved = await s.request("POST", `/api/servers/${id}/versions`, {
      ...admin,
      body: { yaml },
    })
    const versionId = (saved.json.version as { id: string }).id
    const published = await s.request("POST", `/api/servers/${id}/versions/${versionId}/publish`, {
      ...admin,
      body: {},
    })
    expect(published.status, published.text).toBe(200)
    return versionId
  }
  const newKey = async () => {
    const created = await s.request("POST", `/api/servers/${id}/keys`, {
      ...admin,
      body: { name: "test" },
    })
    return created.json as { key: string; info: { id: string; prefix: string } }
  }
  return { s, admin, member, id, putSecret, saveAndPublish, newKey }
}

describe("secrets through the API", () => {
  it("are write-only: no response ever carries the value", async () => {
    const { s, admin, id, putSecret } = await setup()
    const created = await putSecret(SECRET)
    expect(created.status).toBe(200)
    const listed = await s.request("GET", `/api/servers/${id}/secrets`, admin)
    expect(listed.json.secrets).toEqual([
      expect.objectContaining({ name: "API_KEY", allowedHosts: [bound()], usedBy: null }),
    ])
    for (const response of [created, listed]) expect(response.text).not.toContain(SECRET)
    const audit = JSON.stringify(listAudit(s.database.db, s.scope))
    expect(audit).toContain("secret.create")
    expect(audit).not.toContain(SECRET)
  })

  it("are for admins only", async () => {
    const { s, member, id, putSecret } = await setup()
    expect((await putSecret(SECRET, [bound()], member)).status).toBe(403)
    expect((await s.request("GET", `/api/servers/${id}/secrets`, member)).status).toBe(403)
    expect(
      (await s.request("DELETE", `/api/servers/${id}/secrets/API_KEY`, { ...member, body: {} }))
        .status,
    ).toBe(403)
  })

  it("refuses empty hosts, wildcards and bad names", async () => {
    const { s, admin, id, putSecret } = await setup()
    expect((await putSecret(SECRET, [])).status).toBe(400)
    expect((await putSecret(SECRET, ["*.example.com"])).status).toBe(400)
    const badName = await s.request("PUT", `/api/servers/${id}/secrets/lower`, {
      ...admin,
      body: { value: SECRET, allowedHosts: [bound()] },
    })
    expect(badName.status).toBe(400)
  })

  it("rotates: the next call sends the new value, and both stay redacted", async () => {
    const { s, id, putSecret, saveAndPublish, newKey } = await setup()
    await putSecret(SECRET)
    await saveAndPublish(keyedSpec("/echo/rotate"))
    const { key } = await newKey()
    const client = await gatewayClient(s, id, key, cleanups)
    await client.callTool({ name: "keyed", arguments: {} })
    expect(upstream.requests.at(-1)?.headers["x-key"]).toBe(SECRET)

    expect((await putSecret(ROTATED)).status).toBe(200)
    const result = await client.callTool({ name: "keyed", arguments: {} })
    expect(upstream.requests.at(-1)?.headers["x-key"]).toBe(ROTATED)
    expect(JSON.stringify(result)).not.toContain(ROTATED)
    expect(listAudit(s.database.db, s.scope).map((e) => e.action)).toContain("secret.rotate")
  })

  it("warns before deleting a secret the published version uses, then calls fail clearly", async () => {
    const { s, admin, id, putSecret, saveAndPublish, newKey } = await setup()
    await putSecret(SECRET)
    const versionId = await saveAndPublish(keyedSpec("/echo/deleted"))
    const listed = await s.request("GET", `/api/servers/${id}/secrets`, admin)
    expect((listed.json.secrets as { usedBy: unknown }[])[0]?.usedBy).toEqual({
      version: 1,
      versionId,
      tools: ["keyed"],
    })

    const refused = await s.request("DELETE", `/api/servers/${id}/secrets/API_KEY`, {
      ...admin,
      body: {},
    })
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ usedBy: { version: 1, tools: ["keyed"] } })
    expect(String(refused.json.error)).toMatch(/used by the published version 1 \(keyed\)/)

    const deleted = await s.request("DELETE", `/api/servers/${id}/secrets/API_KEY`, {
      ...admin,
      body: { confirm: true },
    })
    expect(deleted.status).toBe(200)
    const { key } = await newKey()
    const client = await gatewayClient(s, id, key, cleanups)
    const result = await client.callTool({ name: "keyed", arguments: {} })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toBe(`Secret API_KEY is not configured for ${bound()}.`)
    expect(upstream.requests.filter((r) => r.path === "/echo/deleted")).toEqual([])
    const event = listAudit(s.database.db, s.scope, { action: "secret.delete" })[0]
    expect(event?.details).toMatchObject({ name: "API_KEY", usedByTools: "keyed" })
  })

  it("refuses an invalid secret name when deleting", async () => {
    const { s, admin, id } = await setup()
    const response = await s.request("DELETE", `/api/servers/${id}/secrets/(a%2B)%2B`, {
      ...admin,
      body: { confirm: true },
    })
    expect(response.status).toBe(400)
  })

  it("deletes an unused secret without confirmation", async () => {
    const { s, admin, id, putSecret } = await setup()
    await putSecret(SECRET)
    const deleted = await s.request("DELETE", `/api/servers/${id}/secrets/API_KEY`, {
      ...admin,
      body: {},
    })
    expect(deleted.status).toBe(200)
  })

  it("applies a narrowed binding at the next call", async () => {
    const { s, id, putSecret, saveAndPublish, newKey } = await setup()
    await putSecret(SECRET)
    await saveAndPublish(keyedSpec("/echo/narrowed"))
    await putSecret(undefined, ["elsewhere.test"])
    const { key } = await newKey()
    const client = await gatewayClient(s, id, key, cleanups)
    const result = await client.callTool({ name: "keyed", arguments: {} })
    expect(resultText(result)).toBe(`Secret API_KEY is not configured for ${bound()}.`)
    expect(upstream.requests.filter((r) => r.path === "/echo/narrowed")).toEqual([])
  })
})

describe("API keys through the API", () => {
  it("shows a key once, lists only its prefix, and revokes it at once", async () => {
    const { s, admin, member, id, saveAndPublish, newKey } = await setup()
    await saveAndPublish(plainSpec("/echo/k"))
    const { key, info } = await newKey()
    expect(key).toMatch(/^kvn_/)
    const listed = await s.request("GET", `/api/servers/${id}/keys`, admin)
    expect(listed.text).not.toContain(key)
    expect(listed.text).not.toContain("hash")
    expect(listed.json.keys).toEqual([
      expect.objectContaining({ id: info.id, prefix: key.slice(0, 12), revokedAt: null }),
    ])

    const client = await gatewayClient(s, id, key, cleanups)
    await client.listTools()
    const used = await s.request("GET", `/api/servers/${id}/keys`, admin)
    expect((used.json.keys as { lastUsedAt: number | null }[])[0]?.lastUsedAt).toBeGreaterThan(0)

    expect(
      (await s.request("DELETE", `/api/servers/${id}/keys/${info.id}`, { ...member, body: {} }))
        .status,
    ).toBe(403)
    expect(
      (await s.request("DELETE", `/api/servers/${id}/keys/${info.id}`, { ...admin, body: {} }))
        .status,
    ).toBe(200)
    await expect(client.listTools()).rejects.toThrow()
  })

  it("are for admins only", async () => {
    const { s, member, id } = await setup()
    expect((await s.request("GET", `/api/servers/${id}/keys`, member)).status).toBe(403)
    const created = await s.request("POST", `/api/servers/${id}/keys`, {
      ...member,
      body: { name: "x" },
    })
    expect(created.status).toBe(403)
  })

  it("cannot revoke another server's key through this server", async () => {
    const { s, admin, id, newKey } = await setup()
    const other = (
      await s.request("POST", "/api/servers", { ...admin, body: { slug: "other", name: "O" } })
    ).json.server as { id: string }
    const { info } = await newKey()
    const crossed = await s.request("DELETE", `/api/servers/${other.id}/keys/${info.id}`, {
      ...admin,
      body: {},
    })
    expect(crossed.status).toBe(404)
    expect((await s.request("GET", `/api/servers/${id}/keys`, admin)).json.keys).toEqual([
      expect.objectContaining({ revokedAt: null }),
    ])
  })
})

describe("versions", () => {
  it("diffs two versions line by line", async () => {
    const { s, admin, id } = await setup()
    const save = async (yaml: string) =>
      (
        (await s.request("POST", `/api/servers/${id}/versions`, { ...admin, body: { yaml } })).json
          .version as { id: string }
      ).id
    const a = await save("specVersion: 1\nname: a\nversion: 1.0.0\n")
    const b = await save("specVersion: 1\nname: b\nversion: 1.0.0\n")
    const diff = await s.request("GET", `/api/servers/${id}/versions/${a}/diff/${b}`, admin)
    expect(diff.json).toMatchObject({
      from: 1,
      to: 2,
      lines: [
        { kind: "same", text: "specVersion: 1" },
        { kind: "removed", text: "name: a" },
        { kind: "added", text: "name: b" },
        { kind: "same", text: "version: 1.0.0" },
        { kind: "same", text: "" },
      ],
    })
  })

  it("records publishing an older version as a rollback and serves it", async () => {
    const { s, admin, id, putSecret, saveAndPublish } = await setup()
    await putSecret(SECRET)
    const v1 = await saveAndPublish(keyedSpec("/echo/v1", "first"))
    await saveAndPublish(keyedSpec("/echo/v2", "second"))
    // Publishing v1 again (an older number than the one served) is a rollback.
    const response = await s.request("POST", `/api/servers/${id}/versions/${v1}/publish`, {
      ...admin,
      body: {},
    })
    expect(response.status).toBe(200)
    const actions = listAudit(s.database.db, s.scope).map((event) => event.action)
    expect(actions[0]).toBe("server.rollback")
    expect(s.studio.gateway.servedVersion(s.scope, id)).toBe(v1)
  })
})

describe("call logs", () => {
  it("records metadata only by default; payloads, redacted and cut, when an admin opts in", async () => {
    const { s, admin, member, id, putSecret, saveAndPublish, newKey } = await setup()
    await putSecret(SECRET)
    const versionId = await saveAndPublish(keyedSpec("/echo/logged"))
    const { key } = await newKey()
    const client = await gatewayClient(s, id, key, cleanups)
    await client.callTool({ name: "keyed", arguments: { note: "first" } })

    let logs = await s.request("GET", `/api/servers/${id}/logs`, admin)
    const first = (logs.json.calls as Record<string, unknown>[])[0]
    expect(first).toMatchObject({ tool: "keyed", status: "ok", versionId, serverId: id })
    expect(first?.durationMs).toEqual(expect.any(Number))
    expect(first?.args).toBeUndefined()
    expect(first?.result).toBeUndefined()

    expect(
      (
        await s.request("PUT", `/api/servers/${id}/settings`, {
          ...member,
          body: { logPayloads: true },
        })
      ).status,
    ).toBe(403)
    expect(
      (
        await s.request("PUT", `/api/servers/${id}/settings`, {
          ...admin,
          body: { logPayloads: true },
        })
      ).status,
    ).toBe(200)
    await client.callTool({ name: "keyed", arguments: { note: "x".repeat(10_000) } })

    logs = await s.request("GET", `/api/servers/${id}/logs`, admin)
    const second = (logs.json.calls as { args?: string; result?: string }[])[0]
    expect(second?.args).toContain("xxx")
    expect(second?.args?.length).toBeLessThan(MAX_PAYLOAD_CHARS + 100)
    // The upstream echoed the key back; the logged result has it redacted.
    expect(second?.result).toContain("[redacted]")
    expect(logs.text).not.toContain(SECRET)

    // A client that sends the secret itself as an argument does not get it into the log.
    await client.callTool({ name: "keyed", arguments: { note: `pasted ${SECRET}` } })
    logs = await s.request("GET", `/api/servers/${id}/logs`, admin)
    const third = (logs.json.calls as { args?: string }[])[0]
    expect(third?.args).toContain("pasted [redacted]")
    expect(logs.text).not.toContain(SECRET)

    // Members see the metadata, never payloads.
    const asMember = await s.request("GET", `/api/servers/${id}/logs`, member)
    expect(asMember.status).toBe(200)
    const memberCalls = asMember.json.calls as Record<string, unknown>[]
    expect(memberCalls.length).toBe(3)
    expect(memberCalls.every((call) => call.args === undefined && call.result === undefined)).toBe(
      true,
    )
  })

  it("logs failed calls and deletes logs past the retention period", async () => {
    const { s, admin, id, putSecret, saveAndPublish, newKey } = await setup()
    await putSecret(SECRET)
    await saveAndPublish(keyedSpec("/fail/always"))
    const { key } = await newKey()
    const client = await gatewayClient(s, id, key, cleanups)
    await client.callTool({ name: "keyed", arguments: {} })
    const logs = await s.request("GET", `/api/servers/${id}/logs`, admin)
    expect((logs.json.calls as { status: string }[])[0]?.status).toBe("error")
    expect(purgeCalls(s.database.db, Date.now() + 1000)).toBe(1)
    expect((await s.request("GET", `/api/servers/${id}/logs`, admin)).json.calls).toEqual([])
  })
})
