import { describe, expect, it } from "vitest"

// The 0.1 public API. Changing this list is an API change: update docs/API.md with it.
describe("@kervan/core public API", () => {
  it("exports exactly these values", async () => {
    expect(Object.keys(await import("../src/index.js")).sort()).toEqual([
      "DEFAULT_MAX_TOOL_INPUT_ELEMENTS",
      "DEFAULT_TOOL_TIMEOUT_MS",
      "FORBIDDEN",
      "InMemoryToolRegistry",
      "KervanDefinitionError",
      "TOOL_NAME_PATTERN",
      "ToolError",
      "createApp",
      "createConsoleLogger",
      "jsonSchema",
      "rawResult",
      "silentLogger",
      "z",
    ])
  })
})
