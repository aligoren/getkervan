// Blocks `npm publish` / `pnpm publish` until the npm scope is secured.
// Set KERVAN_ALLOW_PUBLISH=1 to publish intentionally.
// It also refuses while the package's README still says it is not published (npm shows the README).
import { existsSync, readFileSync } from "node:fs"

if (process.env.KERVAN_ALLOW_PUBLISH !== "1") {
  console.error(
    "Publishing is disabled for Kervan packages until the npm scope is secured. " +
      "Set KERVAN_ALLOW_PUBLISH=1 to override.",
  )
  process.exit(1)
}
if (
  existsSync("README.md") &&
  readFileSync("README.md", "utf8").includes("**Not published yet.**")
) {
  console.error('README.md still says "Not published yet": remove that note before publishing.')
  process.exit(1)
}
