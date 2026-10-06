import { createTestClient } from "@kervan/transport/testing"
import { afterEach, describe, expect, it } from "vitest"
import { app } from "../src/app.js"

afterEach(() => {
  for (const { name } of app.listTools()) if (name.startsWith("counter_")) app.removeTool(name)
})

describe.each(["modern", "legacy"] as const)("dynamic example (%s era)", (era) => {
  it("creates and deletes counter tools, and the client sees each change", async () => {
    const lists: string[][] = []
    const client = await createTestClient(app, {
      era,
      client: {
        listChanged: {
          tools: { onChanged: (_error, tools) => lists.push((tools ?? []).map((t) => t.name)) },
        },
      },
    })

    await client.callTool({ name: "create_counter", arguments: { name: "visits" } })
    await expect.poll(() => lists.at(-1)).toContain("counter_visits")

    const first = await client.callTool({ name: "counter_visits", arguments: {} })
    const second = await client.callTool({ name: "counter_visits", arguments: {} })
    expect([first.structuredContent, second.structuredContent]).toEqual([
      { count: 1 },
      { count: 2 },
    ])

    await client.callTool({ name: "delete_counter", arguments: { name: "visits" } })
    await expect.poll(() => lists.at(-1)).toEqual(["create_counter", "delete_counter"])
    await client.close()
  })
})
