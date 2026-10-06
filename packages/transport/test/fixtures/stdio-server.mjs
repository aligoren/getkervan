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

// Registers another tool at runtime, so tests can trigger a list change deterministically.
app.tool("install_extra", {
  description: "Registers the 'extra' tool",
  handler: () => {
    if (!app.registry.has("extra")) {
      app.tool("extra", { description: "Added at runtime", handler: () => "extra!" })
    }
    return "installed"
  },
})

app.logger.info("fixture ready")
await serve(app)
