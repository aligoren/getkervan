// Security review (phase 4a): the per-key limit counts HTTP requests (T12). A JSON-RPC batch
// would let one request carry many tool calls; this checks that it cannot.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import {
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

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

describe("review: one request is at most one tool call", () => {
  it.each([
    ["2025-03-26", "legacy (batching era)"],
    ["2025-06-18", "legacy"],
    ["2025-11-25", "legacy"],
    ["2026-07-28", "modern"],
  ])("does not run a batch of calls sent as one request (%s, %s)", async (version) => {
    const t = await startTestStudio({ keyRateLimit: 2 })
    cleanups.push(t.close)
    const path = `/echo/batch-${version}`
    const s = await publishedServer(t, spec(echoTool(`http://up.test:${upstream.port}${path}`)))
    const batch = Array.from({ length: 20 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "tools/call",
      params: { name: "echo", arguments: {} },
    }))
    const response = await fetch(s.mcpUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${s.key}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": version,
      },
      body: JSON.stringify(batch),
    })
    await response.text()
    expect(upstream.requests.filter((r) => r.path === path).length).toBeLessThanOrEqual(1)
  })
})
