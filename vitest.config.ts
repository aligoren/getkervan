import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      { test: { name: "core", root: "packages/core", include: ["test/**/*.test.ts"] } },
      { test: { name: "transport", root: "packages/transport", include: ["test/**/*.test.ts"] } },
      {
        test: { name: "example-weather", root: "examples/weather", include: ["test/**/*.test.ts"] },
      },
    ],
  },
})
