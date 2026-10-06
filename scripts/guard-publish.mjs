// Blocks `npm publish` / `pnpm publish` until the npm scope is secured.
// Set KERVAN_ALLOW_PUBLISH=1 to publish intentionally.
if (process.env.KERVAN_ALLOW_PUBLISH !== "1") {
  console.error(
    "Publishing is disabled for Kervan packages until the npm scope is secured. " +
      "Set KERVAN_ALLOW_PUBLISH=1 to override.",
  )
  process.exit(1)
}
