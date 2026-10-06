import { describe, expect, it } from "vitest"

// The 0.1 programmatic API of the `kervan` package (create-kervan uses `run`).
describe("kervan public API", () => {
  it("exports exactly these values", async () => {
    expect(Object.keys(await import("../src/index.js")).sort()).toEqual([
      "CreateError",
      "createProject",
      "run",
    ])
  })
})
