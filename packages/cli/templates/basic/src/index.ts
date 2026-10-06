// stdio by default; `--http` serves Streamable HTTP on http://127.0.0.1:3000/mcp.
import { serve } from "@kervan/transport/node"
import { app } from "./app.ts"

await serve(app)
