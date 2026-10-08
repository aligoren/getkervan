import { createApp, ToolError, z } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"

const app = createApp({ name: "calculator", version: "0.1.0" })

app.tool("add", {
  description: "Adds two numbers.",
  input: z.object({ a: z.number(), b: z.number() }),
  output: z.object({ sum: z.number() }),
  annotations: { readOnlyHint: true },
  handler: ({ a, b }) => {
    if (!Number.isFinite(a + b)) throw new ToolError("The sum is too large.")
    return { sum: a + b }
  },
})

const client = await createTestClient(app)
const result = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } })
console.log(`sum: ${(result.structuredContent as { sum: number }).sum}`)
await client.close()
