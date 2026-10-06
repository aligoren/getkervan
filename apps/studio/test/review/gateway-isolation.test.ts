// Security review (phase 4a): per-server isolation at /s/{serverId}/mcp. Every test asserts the
// secure behavior; a failing test is a demonstrated gap.
import { request as httpRequest } from "node:http"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createWorkspace } from "../../src/db/repos/workspaces.js"
import {
  connect,
  echoTool,
  MODERN,
  publishedServer,
  spec,
  startTestStudio,
  startUpstream,
  type TestStudio,
  type Upstream,
  user,
} from "../helpers.js"

let upstream: Upstream
let base: string
beforeAll(async () => {
  upstream = await startUpstream()
  base = `http://up.test:${upstream.port}`
})
afterAll(() => upstream.close())

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function studio(options: Parameters<typeof startTestStudio>[0] = {}) {
  const t = await startTestStudio(options)
  cleanups.push(t.close)
  return t
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const TOOLS_LIST = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/list",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": MODERN,
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
})

/** A raw POST with the path sent exactly as written (no client-side normalization). */
function rawPost(
  t: TestStudio,
  path: string,
  key: string,
  body: string | Buffer = TOOLS_LIST,
  options: { chunked?: boolean } = {},
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: Number(t.url.port),
        method: "POST",
        path,
        headers: {
          host: `127.0.0.1:${t.url.port}`,
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MODERN,
          "mcp-method": "tools/list",
          ...(options.chunked ? { "transfer-encoding": "chunked" } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }),
        )
      },
    )
    // A server may answer early and reset the connection while the body is still being sent.
    req.on("error", (error: NodeJS.ErrnoException) =>
      error.code === "ECONNRESET" || error.code === "EPIPE"
        ? resolve({ status: 0, text: error.code })
        : reject(error),
    )
    if (options.chunked && Buffer.isBuffer(body)) {
      for (let i = 0; i < body.length; i += 64 * 1024) req.write(body.subarray(i, i + 64 * 1024))
    } else req.write(body)
    req.end()
  })
}

async function twoServers() {
  const t = await studio()
  const scope = createWorkspace(t.database.db, "w")
  const a = await publishedServer(t, spec(echoTool(`${base}/echo/a`, "alpha_tool")), {
    scope,
    slug: "a",
  })
  const otherScope = createWorkspace(t.database.db, "other")
  const b = await publishedServer(t, spec(echoTool(`${base}/echo/b`, "beta_tool")), {
    scope: otherScope,
    slug: "b",
  })
  return { t, a, b }
}

describe("review: path variants never reach another server", () => {
  it("answers with the key's own server or not at all, for every encoding of the path", async () => {
    const { t, a, b } = await twoServers()
    const A = a.server.id
    const B = b.server.id
    const encodedA = [...A].map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join("")
    const variants = [
      `/s/${B}/mcp`,
      `/s/${B}/mcp/`,
      `//s/${B}/mcp`,
      `/s/${B.toUpperCase()}/mcp`,
      `/s/${A}/../${B}/mcp`,
      `/s/${B}/../${A}/mcp`,
      `/s/${A}%2F..%2F${B}/mcp`,
      `/s/${B}%2F..%2F${A}/mcp`,
      `/s/${A}/mcp/../../${B}/mcp`,
      `/s/${encodedA}/mcp`,
      `/s/${A}/mcp?serverId=${B}`,
      `/s/${A}/mcp;${B}`,
      `/S/${A}/MCP`,
    ]
    for (const path of variants) {
      const { status, text } = await rawPost(t, path, a.key)
      expect(text, path).not.toContain("beta_tool")
      if (status === 200) expect(text, path).toContain("alpha_tool")
      // And B's key on the same shapes never sees A's tools.
      const swapped = path.replaceAll(A, "@@A@@").replaceAll(B, A).replaceAll("@@A@@", B)
      const other = await rawPost(t, swapped, b.key)
      expect(other.text, swapped).not.toContain("alpha_tool")
    }
  })

  it("gives every refusal the same body, so it reveals nothing about the server", async () => {
    const { t, a, b } = await twoServers()
    const bodies = new Set<string>()
    for (const [path, key] of [
      [`/s/${b.server.id}/mcp`, a.key],
      [`/s/${crypto.randomUUID()}/mcp`, a.key],
      [`/s/${a.server.id}/mcp`, `kvn_${"A".repeat(43)}`],
    ] as const) {
      const response = await rawPost(t, path, key)
      expect(response.status, path).toBe(401)
      bodies.add(response.text)
    }
    expect(bodies.size).toBe(1)
  })
})

describe("review: revocation and list_changed", () => {
  it("stops notifying a client whose key was revoked", async () => {
    const t = await studio()
    const s = await publishedServer(t, spec(echoTool(`${base}/echo/rev`)))
    const client = await connect(s.mcpUrl, s.key)
    cleanups.push(() => client.close())
    let notified = 0
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      notified++
    })
    await client.listen({ toolsListChanged: true })

    const [info] = t.database.sqlite
      .prepare("SELECT id FROM api_keys WHERE server_id = ?")
      .all(s.server.id) as { id: string }[]
    t.studio.revokeApiKey(s.scope, info?.id ?? "", user())

    const v2 = t.studio.saveVersion(
      s.scope,
      s.server.id,
      spec(`${echoTool(`${base}/echo/rev`)}${echoTool(`${base}/echo/rev2`, "added_after_revoke")}`),
      user(),
    )
    await t.studio.publish(s.scope, s.server.id, v2.id, user())
    await sleep(300)
    // "Revocation takes effect on the next request": an open subscription stream is a request
    // that keeps running, so the revoked holder keeps learning when the server changes.
    expect(notified).toBe(0)
  })

  it("does not serve a deleted server's tools to a client that was connected", async () => {
    const t = await studio()
    const s = await publishedServer(t, spec(echoTool(`${base}/echo/del`)))
    const client = await connect(s.mcpUrl, s.key)
    cleanups.push(() => client.close())
    await t.studio.deleteServer(s.scope, s.server.id, user())
    const listed = await client.listTools().then(
      (r) => r.tools.map((tool) => tool.name),
      () => [],
    )
    expect(listed).toEqual([])
    const called = await client.callTool({ name: "echo", arguments: {} }).then(
      (r) => !r.isError,
      () => false,
    )
    expect(called).toBe(false)
  })
})

describe("review: request body limit (T12)", () => {
  it("refuses a body over 1 MiB, with or without Content-Length", async () => {
    const t = await studio()
    const s = await publishedServer(t, spec(echoTool(`${base}/echo/big`)))
    const padding = "x".repeat(2 * 1024 * 1024)
    const big = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { padding } }),
    )
    const path = `/s/${s.server.id}/mcp`
    // 413, or the connection cut while sending (status 0); never processed.
    const declared = await rawPost(t, path, s.key, big)
    expect([0, 413], `declared: ${declared.text.slice(0, 80)}`).toContain(declared.status)
    const chunked = await rawPost(t, path, s.key, big, { chunked: true })
    expect([0, 413], `chunked: ${chunked.text.slice(0, 80)}`).toContain(chunked.status)
    // Studio is still serving afterwards.
    expect((await rawPost(t, path, s.key)).status).toBe(200)
  })
})
