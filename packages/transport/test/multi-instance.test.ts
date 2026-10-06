import { type App, createApp, InMemoryToolRegistry, silentLogger } from "@kervan/core"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { afterEach, describe, expect, it } from "vitest"
import { type HttpServerHandle, serveHttp } from "../src/node.js"
import { MODERN } from "./helpers.js"

/**
 * The multi-instance contract: a shared registry fires onChange on every instance. Here each "node"
 * keeps a local registry and applies changes it receives from a fake pub/sub, the way a
 * database-backed registry would reload after a change notification.
 */
class FakePubSub {
  readonly #subscribers = new Set<(message: Change) => void>()
  publish(message: Change) {
    // Asynchronous, like a real broker.
    setTimeout(() => {
      for (const subscriber of this.#subscribers) subscriber(message)
    }, 5)
  }
  subscribe(subscriber: (message: Change) => void) {
    this.#subscribers.add(subscriber)
  }
}

type Change = { op: "add"; name: string; text: string } | { op: "remove"; name: string }

class SharedRegistry extends InMemoryToolRegistry {
  constructor(private readonly bus: FakePubSub) {
    super()
    bus.subscribe((change) => this.#apply(change))
  }
  publishAdd(name: string, text: string) {
    this.bus.publish({ op: "add", name, text })
  }
  publishRemove(name: string) {
    this.bus.publish({ op: "remove", name })
  }
  #apply(change: Change) {
    if (change.op === "remove") this.remove(change.name)
    else if (!this.has(change.name)) {
      this.add(change.name, { description: change.text, handler: () => change.text })
    }
  }
}

const handles: HttpServerHandle[] = []
const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(handles.splice(0).map((handle) => handle.close()))
})

async function node(bus: FakePubSub): Promise<{ app: App; registry: SharedRegistry; url: URL }> {
  const registry = new SharedRegistry(bus)
  const app = createApp({ name: "cluster", version: "0.0.0", logger: silentLogger, registry })
  const handle = await serveHttp(app, { port: 0, rateLimit: false })
  handles.push(handle)
  return { app, registry, url: handle.url }
}

describe("multiple instances", () => {
  it("delivers a change made on node A to a client connected to node B", async () => {
    const bus = new FakePubSub()
    const a = await node(bus)
    const b = await node(bus)

    const client = new Client(
      { name: "cluster-client", version: "0.0.0" },
      { versionNegotiation: { mode: { pin: MODERN } } },
    )
    await client.connect(new StreamableHTTPClientTransport(b.url))
    clients.push(client)
    let notified = 0
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      notified++
    })
    await client.listen({ toolsListChanged: true })
    expect((await client.listTools()).tools).toEqual([])

    a.registry.publishAdd("deploy", "deployed")
    await expect.poll(() => notified).toBe(1)
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(["deploy"])
    const result = await client.callTool({ name: "deploy", arguments: {} })
    expect(result.content).toEqual([{ type: "text", text: "deployed" }])

    a.registry.publishRemove("deploy")
    await expect.poll(() => notified).toBe(2)
    expect((await client.listTools()).tools).toEqual([])
  })
})
