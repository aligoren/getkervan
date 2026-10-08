// Copies the editor schema from @kervan/spec-runtime to the website (site/static/schema/v1.json).
// The package's file is the source; a test checks that the copy is identical.
import { copyFileSync } from "node:fs"

const source = new URL("../packages/spec-runtime/schema/kervan.schema.json", import.meta.url)
const target = new URL("../site/static/schema/v1.json", import.meta.url)
copyFileSync(source, target)
console.log(`Copied ${source.pathname} to ${target.pathname}`)
