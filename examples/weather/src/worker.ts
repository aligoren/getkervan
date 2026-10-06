// Cloudflare Workers / Deno / Bun entry: `export default` a fetch handler.
// List the hostnames you deploy to; other Host headers are rejected (DNS rebinding protection).
import { toFetchHandler } from "@kervan/transport"
import { app } from "./app.js"

export default toFetchHandler(app, { allowedHosts: ["kervan-weather.example.workers.dev"] })
