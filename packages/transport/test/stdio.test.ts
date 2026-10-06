import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { afterEach, describe, expect, it } from "vitest"
import { MODERN } from "./helpers.js"

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url))
const clients: Client[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

async function spawnClient(era: "modern" | "legacy") {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fixture],
    stderr: "pipe",
  })
  let stderr = ""
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  const errors: Error[] = []
  const client = new Client(
    { name: "stdio-test", version: "0.0.0" },
    era === "modern" ? { versionNegotiation: { mode: { pin: MODERN } } } : {},
  )
  client.onerror = (error) => errors.push(error)
  await client.connect(transport)
  clients.push(client)
  return { client, errors, stderr: () => stderr }
}

describe.each(["legacy", "modern"] as const)("stdio (%s era)", (era) => {
  it("lists and calls tools over a spawned process", async () => {
    const { client, errors } = await spawnClient(era)
    expect(client.getProtocolEra()).toBe(era)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(["add", "install_extra"])
    const result = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } })
    expect(result.content).toEqual([{ type: "text", text: "5" }])
    expect(errors).toEqual([])
  })

  it("pushes list_changed when the server adds a tool at runtime", async () => {
    const { client, errors } = await spawnClient(era)
    let notified = 0
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      notified++
    })
    if (era === "modern") await client.listen({ toolsListChanged: true })

    await client.callTool({ name: "install_extra", arguments: {} })
    await expect.poll(() => notified).toBe(1)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(["add", "install_extra", "extra"])
    const result = await client.callTool({ name: "extra", arguments: {} })
    expect(result.content).toEqual([{ type: "text", text: "extra!" }])
    expect(errors).toEqual([])
  })

  it("keeps logs on stderr so stdout stays pure JSON-RPC", async () => {
    const { client, errors, stderr } = await spawnClient(era)
    await client.callTool({ name: "add", arguments: { a: 1, b: 1 } })
    await expect.poll(stderr).toContain("adding on stdio")
    expect(stderr()).toContain("fixture ready")
    expect(errors).toEqual([])
  })
})
