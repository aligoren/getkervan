// Spawned by stdio.test.ts. Imports the built packages, like a real user project would.
import { createApp, z } from "@kervan/core"
import { serve } from "@kervan/transport/node"

const app = createApp({ name: "stdio-fixture", version: "0.0.1" })

app.tool("add", {
  description: "Adds two numbers",
  input: z.object({ a: z.number(), b: z.number() }),
  handler: ({ a, b }, ctx) => {
    ctx.log.info("adding on stdio", { a, b })
    return String(a + b)
  },
})

app.logger.info("fixture ready")
await serve(app)
