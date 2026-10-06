import { createApp, ToolError, z } from "@kervan/core"

export const app = createApp({ name: "{{name}}", version: "0.1.0" })

app.tool("greet", {
  description: "Greets someone by name.",
  input: z.object({ name: z.string().min(1).describe("Who to greet") }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ name }) => `Hello, ${name}!`,
})

app.tool("divide", {
  description: "Divides a by b.",
  input: z.object({ a: z.number(), b: z.number() }),
  output: z.object({ result: z.number() }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  handler: ({ a, b }) => {
    if (b === 0) throw new ToolError("Cannot divide by zero. Use a non-zero b.")
    return { result: a / b }
  },
})
