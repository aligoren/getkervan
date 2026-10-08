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
      { test: { name: "studio", root: "apps/studio", include: ["test/**/*.test.ts"] } },
      {
        test: {
          name: "studio-web",
          root: "apps/studio/web",
          include: ["test/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["test/setup.ts"],
        },
      },
      // Repository-wide checks (the website, where the domain may appear).
      { test: { name: "repo", root: "scripts", include: ["test/**/*.test.ts"] } },
      {
        test: { name: "example-weather", root: "examples/weather", include: ["test/**/*.test.ts"] },
      },
      {
        test: { name: "example-dynamic", root: "examples/dynamic", include: ["test/**/*.test.ts"] },
      },
      {
        test: {
          name: "example-calculator",
          root: "examples/calculator",
          include: ["test/**/*.test.ts"],
        },
      },
    ],
  },
})
