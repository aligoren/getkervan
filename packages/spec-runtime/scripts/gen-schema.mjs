// Regenerates schema/kervan.schema.json from the Zod spec schema (run after `pnpm build`).
// Then run `pnpm site:schema` at the repository root to refresh the website's copy.
import { writeFileSync } from "node:fs"
import { specJsonSchema } from "../dist/spec-schema.js"
import { SCHEMA_ID } from "./schema-id.mjs"

const { $schema, ...rest } = specJsonSchema()
const target = new URL("../schema/kervan.schema.json", import.meta.url)
writeFileSync(target, `${JSON.stringify({ $schema, $id: SCHEMA_ID, ...rest }, null, 2)}\n`)
console.log(`Wrote ${target.pathname}`)
