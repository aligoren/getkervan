import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      { test: { name: "core", root: "packages/core", include: ["test/**/*.test.ts"] } },
      { test: { name: "transport", root: "packages/transport", include: ["test/**/*.test.ts"] } },
      { test: { name: "cli", root: "packages/cli", include: ["test/**/*.test.ts"] } },
      {
        test: {
          name: "spec-runtime",
          root: "packages/spec-runtime",
          include: ["test/**/*.test.ts"],
        },
      },
      {
        test: { name: "example-weather", root: "examples/weather", include: ["test/**/*.test.ts"] },
      },
      {
        test: { name: "example-dynamic", root: "examples/dynamic", include: ["test/**/*.test.ts"] },
      },
    ],
  },
})
