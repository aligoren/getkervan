// Independent review: playground tokens (T8b): scope, expiry, forgery, deleted servers, and
// whether a token outlives the session that issued it.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { PLAYGROUND_TOKEN_TTL_MS, PlaygroundTokens } from "../../src/playground.js"
import { type ApiStudio, apiStudio, PASSWORD } from "../api-helpers.js"
import { echoTool, MODERN, spec, startUpstream, type Upstream } from "../helpers.js"

let upstream: Upstream
beforeAll(async () => {
  upstream = await startUpstream()
})
afterAll(() => upstream.close())

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

/** A raw tools/list through Studio's whole HTTP app. */
function toolsList(s: ApiStudio, serverId: string, bearer: string) {
  return s.request("POST", `/s/${serverId}/mcp`, {
    headers: {
      authorization: `Bearer ${bearer}`,
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN,
      "mcp-method": "tools/list",
    },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MODERN,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    },
  })
}

async function setup() {
  const s = apiStudio()
  studios.push(s)
  await s.addUser("admin@example.test", "admin")
  await s.addUser("member@example.test", "member")
  const admin = await s.signIn("admin@example.test")
  const member = await s.signIn("member@example.test", PASSWORD, "203.0.113.20")
  const server = async (slug: string) => {
    const created = await s.request("POST", "/api/servers", {
      ...admin,
      body: { slug, name: slug },
    })
    const id = (created.json.server as { id: string }).id
    const saved = await s.request("POST", `/api/servers/${id}/versions`, {
      ...admin,
      body: {
        yaml: spec(echoTool(`${upstream.url}/echo/${slug}`, `tool_${slug.replace("-", "_")}`)),
      },
    })
    return { id, vid: (saved.json.version as { id: string }).id }
  }
  const grant = async (who: { cookie: string; csrf: string }, id: string, vid: string) => {
    const response = await s.request("POST", `/api/servers/${id}/versions/${vid}/playground`, {
      ...who,
      body: {},
    })
    expect(response.status).toBe(200)
    return String(response.json.token)
  }
  return { s, admin, member, server, grant }
}

describe("playground tokens", () => {
  it("work for their own server only, with one answer for every refusal", async () => {
    const { s, admin, server, grant } = await setup()
    const a = await server("srv-a")
    const b = await server("srv-b")
    const token = await grant(admin, a.id, a.vid)
    expect((await toolsList(s, a.id, token)).status).toBe(200)
    const other = await toolsList(s, b.id, token)
    const forged = await toolsList(s, a.id, `${token.slice(0, -2)}AA`)
    const foreignKey = await toolsList(
      s,
      a.id,
      new PlaygroundTokens().issue({
        workspaceId: s.scope.workspaceId,
        serverId: a.id,
        versionId: a.vid,
        userId: "x",
        sessionHash: "x",
      }).token,
    )
    expect([other.status, forged.status, foreignKey.status]).toEqual([401, 401, 401])
    expect(new Set([other.text, forged.text, foreignKey.text]).size).toBe(1)
  })

  it("cannot be re-pointed at another version by editing the payload", async () => {
    const { s, admin, server, grant } = await setup()
    const a = await server("srv-a")
    const token = await grant(admin, a.id, a.vid)
    const [payload = "", signature = ""] = token.slice(4).split(".")
    const grantData = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    const edited = Buffer.from(JSON.stringify({ ...grantData, versionId: "other" })).toString(
      "base64url",
    )
    expect((await toolsList(s, a.id, `kvp_${edited}.${signature}`)).status).toBe(401)
  })

  it("expire after 15 minutes", () => {
    const tokens = new PlaygroundTokens()
    const now = Date.now()
    const { token } = tokens.issue(
      { workspaceId: "w", serverId: "s", versionId: "v", userId: "u", sessionHash: "h" },
      now,
    )
    expect(tokens.verify(token, now + PLAYGROUND_TOKEN_TTL_MS - 1)).toBeDefined()
    expect(tokens.verify(token, now + PLAYGROUND_TOKEN_TTL_MS)).toBeUndefined()
  })

  it("stop working when their server is deleted", async () => {
    const { s, admin, server, grant } = await setup()
    const a = await server("srv-a")
    const token = await grant(admin, a.id, a.vid)
    expect((await toolsList(s, a.id, token)).status).toBe(200)
    await s.request("DELETE", `/api/servers/${a.id}`, { ...admin, body: {} })
    const after = await toolsList(s, a.id, token)
    expect(after.status).not.toBe(200)
    expect(after.text).not.toContain("tool_srv_a")
  })

  // Not claimed by the threat model, but expected of a session-derived credential: signing out
  // (or having the session ended by `reset-admin`) should end the playground access it granted.
  it("stop working once the session that issued them has ended", async () => {
    const { s, member, server, grant } = await setup()
    const a = await server("srv-a")
    const token = await grant(member, a.id, a.vid)
    expect((await toolsList(s, a.id, token)).status).toBe(200)
    expect((await s.request("POST", "/api/logout", member)).status).toBe(200)
    expect((await toolsList(s, a.id, token)).status).toBe(401)
  })
})
