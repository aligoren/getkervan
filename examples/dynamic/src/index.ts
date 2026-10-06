// Single tool set, on stdio (default) or HTTP (--http).
import { serve } from "@kervan/transport/node"
import { app } from "./app.js"

await serve(app)
