// Runs on stdio by default; pass --http (or KERVAN_TRANSPORT=http) for Streamable HTTP.
import { serve } from "@kervan/transport/node"
import { app } from "./app.js"

await serve(app)
