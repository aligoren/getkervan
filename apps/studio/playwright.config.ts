import { tmpdir } from "node:os"
import path from "node:path"
import { defineConfig } from "@playwright/test"

// Opt-in end-to-end tests (`pnpm e2e` at the root): they start the built Studio, so build first,
// and they need Playwright's Chromium (`pnpm --filter @kervan/studio exec playwright install chromium`).
export default defineConfig({
  testDir: "e2e",
  // One Studio, one story: the tests run in order.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: "list",
  // Traces and screenshots of failures stay out of the repository.
  outputDir: path.join(tmpdir(), "kervan-studio-e2e-results"),
  use: { browserName: "chromium", trace: "retain-on-failure" },
})
