import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { afterEach, describe, expect, it } from "vitest"
import {
  type App,
  createApp,
  InMemoryToolRegistry,
  silentLogger,
  type ToolEntry,
  type ToolRegistry,
} from "../src/index.js"

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

const newApp = () => createApp({ name: "live", version: "0.0.0", logger: silentLogger })
const def = (description = "d") => ({ description, handler: () => description })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A legacy-era client on a live server, counting list_changed notifications. */
async function connectLive(app: App, registry?: ToolRegistry) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const live = app.createLiveServer(registry)
  await live.server.connect(serverTransport)
  const client = new Client({ name: "live-test", version: "0.0.0" })
  let notifications = 0
  client.setNotificationHandler("notifications/tools/list_changed", () => {
    notifications++
  })
  await client.connect(clientTransport)
  cleanups.push(async () => {
    await client.close()
    await live.server.close()
  })
  const names = async () => (await client.listTools()).tools.map((tool) => tool.name)
  return { client, live, names, notifications: () => notifications }
}

describe("createLiveServer", () => {
  it("advertises listChanged and answers tools/list with an empty registry", async () => {
    const app = newApp()
    const { client, names } = await connectLive(app)
    expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: true })
    expect(await names()).toEqual([])
  })

  it("follows adds, replacements and removals with one notification per batch", async () => {
    const app = newApp().tool("a", def("a1"))
    const { client, names, notifications } = await connectLive(app)

    app.tool("b", def()).tool("c", def())
    await expect.poll(notifications).toBe(1)
    expect(await names()).toEqual(["a", "b", "c"])

    app.replaceTool("a", def("a2"))
    await expect.poll(notifications).toBe(2)
    expect(await names()).toEqual(["a", "b", "c"])
    const result = await client.callTool({ name: "a", arguments: {} })
    expect(result.content).toEqual([{ type: "text", text: "a2" }])

    app.removeTool("b")
    await expect.poll(notifications).toBe(3)
    expect(await names()).toEqual(["a", "c"])
    await sleep(20)
    expect(notifications()).toBe(3)
  })

  it("clears optional fields a replacement drops", async () => {
    const app = newApp().tool("a", {
      title: "Old",
      description: "d",
      annotations: { readOnlyHint: true },
      handler: () => "",
    })
    const { client, notifications } = await connectLive(app)
    app.replaceTool("a", def())
    await expect.poll(notifications).toBe(1)
    const [tool] = (await client.listTools()).tools
    expect(tool?.title).toBeUndefined()
    expect(tool?.annotations).toBeUndefined()
  })

  it("sends nothing when the registry reports a change without new entries", async () => {
    const inner = new InMemoryToolRegistry()
    inner.add("a", def())
    const listeners = new Set<() => void>()
    const noisy: ToolRegistry & { emit(): void } = {
      list: () => inner.list(),
      onChange: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      emit: () => {
        for (const listener of listeners) listener()
      },
    }
    const { notifications, names } = await connectLive(newApp(), noisy)
    noisy.emit()
    noisy.emit()
    await sleep(30)
    expect(notifications()).toBe(0)

    inner.add("b", def())
    noisy.emit()
    await expect.poll(notifications).toBe(1)
    expect(await names()).toEqual(["a", "b"])
  })

  it("stops following the registry once disposed or closed", async () => {
    const app = newApp()
    let subscribers = 0
    const counting: ToolRegistry = {
      list: (): readonly ToolEntry[] => app.registry.list(),
      onChange: (listener) => {
        subscribers++
        const off = app.registry.onChange(listener)
        return () => {
          subscribers--
          off()
        }
      },
    }
    const live = app.createLiveServer(counting)
    expect(subscribers).toBe(1)
    live.dispose()
    live.dispose()
    expect(subscribers).toBe(0)

    const closed = app.createLiveServer(counting)
    expect(subscribers).toBe(1)
    await closed.server.close()
    expect(subscribers).toBe(0)
  })
})
