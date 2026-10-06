#!/usr/bin/env node
// `npm create kervan@latest my-server` runs this with ["my-server"].
import { run } from "kervan"

process.exitCode = await run(["create", ...process.argv.slice(2)])
