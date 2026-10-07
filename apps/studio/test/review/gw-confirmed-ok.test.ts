// Security review (release, gateway): checks that held up, kept as regression tests.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { MAX_STREAMS_PER_CALLER } from "../../src/gateway.js"
import {
  connect,
  echoTool,
  publishedServer,
  spec,
  startTestStudio,
  startUpstream,
  type Upstream,
} from "../helpers.js"

let upstream: Upstream
beforeAll(async () => {
  upstream = await startUpstream()
})
afterAll(() => upstream.close())

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe("review-gw (ok): batches are refused whatever the JSON content type is spelled like", () => {
  it.each([
    "application/json; charset=utf-8",
    "Application/JSON",
    "application/json ; charset=UTF-8",
  ])("runs at most one call for a batch sent as %s", async (contentType) => {
    const t = await startTestStudio()
    cleanups.push(t.close)
    const path = `/echo/ct-${contentType.replace(/\W/g, "")}`
    const s = await publishedServer(t, spec(echoTool(`http://up.test:${upstream.port}${path}`)))
    const batch = Array.from({ length: 10 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    }))
    const response = await fetch(s.mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${s.key}`,
        "content-type": contentType,
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
      },
      body: JSON.stringify(batch),
    })
    await response.text()
    expect(upstream.requests.filter((r) => r.path === path).length).toBeLessThanOrEqual(1)
  })
})

describe("review-gw (ok): the per-key stream cap holds under concurrency", () => {
  it("keeps at most the cap open when more listens arrive at once", async () => {
    const t = await startTestStudio()
    cleanups.push(t.close)
    const s = await publishedServer(t, spec(echoTool(`http://up.test:${upstream.port}/echo/s`)))
    const clients = await Promise.all(
      Array.from({ length: MAX_STREAMS_PER_CALLER + 8 }, () => connect(s.mcpUrl, s.key)),
    )
    for (const client of clients) cleanups.push(() => client.close())
    const outcomes = await Promise.allSettled(
      clients.map((client) => client.listen({ toolsListChanged: true })),
    )
    for (let i = 0; i < 50; i++) await sleep(20)
    expect(t.studio.gateway.openStreams).toBeLessThanOrEqual(MAX_STREAMS_PER_CALLER)
    expect(outcomes.filter((o) => o.status === "rejected").length).toBeGreaterThanOrEqual(8)
  })
})
