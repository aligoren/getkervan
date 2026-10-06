// Regenerates schema/kervan.schema.json from the Zod spec schema (run after `pnpm build`).
import { writeFileSync } from "node:fs"
import { specJsonSchema } from "../dist/spec-schema.js"

const target = new URL("../schema/kervan.schema.json", import.meta.url)
writeFileSync(target, `${JSON.stringify(specJsonSchema(), null, 2)}\n`)
console.log(`Wrote ${target.pathname}`)
