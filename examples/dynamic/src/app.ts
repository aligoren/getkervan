import { createApp, ToolError, z } from "@kervan/core"

export const app = createApp({ name: "kervan-dynamic", version: "0.1.0" })

const counterName = z
  .string()
  .regex(/^[a-z0-9_]{1,32}$/)
  .describe("Lowercase letters, digits and underscores")

// Tools that change the tool set at runtime. Connected clients get list_changed automatically.
app.tool("create_counter", {
  description: "Creates a tool named counter_<name> that counts how often it is called.",
  input: z.object({ name: counterName }),
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  handler: ({ name }) => {
    const tool = `counter_${name}`
    if (app.registry.has(tool)) throw new ToolError(`${tool} already exists.`)
    let count = 0
    app.tool(tool, {
      description: `Increments and returns the "${name}" counter.`,
      output: z.object({ count: z.number() }),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
      handler: () => ({ count: ++count }),
    })
    return `Created ${tool}.`
  },
})

app.tool("delete_counter", {
  description: "Deletes the counter_<name> tool.",
  input: z.object({ name: counterName }),
  annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false },
  handler: ({ name }) =>
    app.removeTool(`counter_${name}`)
      ? `Deleted counter_${name}.`
      : `counter_${name} did not exist.`,
})
