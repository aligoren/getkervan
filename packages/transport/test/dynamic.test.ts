import {
  createApp,
  InMemoryToolRegistry,
  silentLogger,
  type ToolEntry,
  type ToolRegistry,
} from "@kervan/core"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { afterEach, describe, expect, it } from "vitest"
import { type HttpServerHandle, serveHttp } from "../src/node.js"
import { createTestClient, type TestClientOptions } from "../src/testing.js"
import { MODERN } from "./helpers.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

const newApp = () => createApp({ name: "dynamic", version: "0.0.0", logger: silentLogger })
const def = (text: string) => ({ description: text, handler: () => text })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Connects a client that counts raw list_changed notifications (opening a listen stream if modern). */
async function watch(client: Client) {
  let count = 0
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    count++
  })
  if (client.getProtocolEra() === "modern") await client.listen({ toolsListChanged: true })
  const names = async () => (await client.listTools()).tools.map((tool) => tool.name)
  return { count: () => count, names }
}

async function testClient(...args: Parameters<typeof createTestClient>) {
  const client = await createTestClient(...args)
  cleanups.push(() => client.close())
  return client
}

/** A registry that can report "changed" without changing, to prove no spurious notifications. */
function noisyRegistry() {
  const inner = new InMemoryToolRegistry()
  const listeners = new Set<() => void>()
  inner.onChange(() => {
    for (const listener of listeners) listener()
  })
  const registry: ToolRegistry & { emit(): void } = {
    list: (): readonly ToolEntry[] => inner.list(),
    onChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    emit: () => {
      for (const listener of listeners) listener()
    },
  }
  return { inner, registry }
}

describe.each(["modern", "legacy"] as const)("list_changed (%s era)", (era) => {
  it("keeps a connected client's tool list current via listChanged", async () => {
    const app = newApp().tool("a", def("a"))
    const seen: string[][] = []
    await testClient(app, {
      era,
      client: {
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (!error && tools) seen.push(tools.map((tool) => tool.name))
            },
          },
        },
      },
    } satisfies TestClientOptions)

    app.tool("b", def("b"))
    await expect.poll(() => seen.at(-1)).toEqual(["a", "b"])
    app.replaceTool("a", def("a2"))
    app.removeTool("b")
    await expect.poll(() => seen.at(-1)).toEqual(["a"])
  })

  it("sends one notification per batch and keeps registry order", async () => {
    const app = newApp().tool("a", def("a")).tool("b", def("b"))
    const client = await testClient(app, { era })
    const { count, names } = await watch(client)

    app.tool("c", def("c")).tool("d", def("d"))
    await expect.poll(count).toBe(1)
    expect(await names()).toEqual(["a", "b", "c", "d"])

    app.replaceTool("b", def("b2"))
    await expect.poll(count).toBe(2)
    expect(await names()).toEqual(["a", "b", "c", "d"])
    const result = await client.callTool({ name: "b", arguments: {} })
    expect(result.content).toEqual([{ type: "text", text: "b2" }])
    await sleep(30)
    expect(count()).toBe(2)
  })

  it("serves an empty registry and announces the first tool", async () => {
    const app = newApp()
    const client = await testClient(app, { era })
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true)
    const { count, names } = await watch(client)
    expect(await names()).toEqual([])
    app.tool("first", def("first"))
    await expect.poll(count).toBe(1)
    expect(await names()).toEqual(["first"])
  })

  it("does not notify when the registry reports a change with identical entries", async () => {
    const { inner, registry } = noisyRegistry()
    inner.add("a", def("a"))
    const client = await testClient(newApp(), { era, registry })
    const { count, names } = await watch(client)

    registry.emit()
    registry.emit()
    await sleep(50)
    expect(count()).toBe(0)

    inner.add("b", def("b"))
    await expect.poll(count).toBe(1)
    expect(await names()).toEqual(["a", "b"])
  })
})

describe("list_changed over real HTTP", () => {
  let handle: HttpServerHandle | undefined
  afterEach(async () => {
    await handle?.close()
    handle = undefined
  })

  async function connect(url: URL, era: "modern" | "legacy") {
    const client = new Client(
      { name: "http-dynamic", version: "0.0.0" },
      era === "modern" ? { versionNegotiation: { mode: { pin: MODERN } } } : {},
    )
    await client.connect(new StreamableHTTPClientTransport(url))
    cleanups.push(() => client.close())
    return client
  }

  it("pushes list_changed to modern clients on their subscriptions/listen stream", async () => {
    const app = newApp().tool("a", def("a"))
    handle = await serveHttp(app, { port: 0 })
    const { count, names } = await watch(await connect(handle.url, "modern"))
    app.tool("b", def("b"))
    await expect.poll(count).toBe(1)
    expect(await names()).toEqual(["a", "b"])
  })

  it("cannot push to stateless legacy clients, which see the change on their next tools/list", async () => {
    const app = newApp().tool("a", def("a"))
    handle = await serveHttp(app, { port: 0 })
    const { count, names } = await watch(await connect(handle.url, "legacy"))
    expect(await names()).toEqual(["a"])
    app.tool("b", def("b"))
    await sleep(50)
    expect(count()).toBe(0)
    expect(await names()).toEqual(["a", "b"])
  })
})
