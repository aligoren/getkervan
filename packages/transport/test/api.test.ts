import { describe, expect, it } from "vitest"

// The 0.1 public API. Changing these lists is an API change: update docs/API.md with them.
describe("@kervan/transport public API", () => {
  it.each([
    ["@kervan/transport", "../src/index.js", ["toFetchHandler"]],
    ["@kervan/transport/node", "../src/node.js", ["serve", "serveHttp", "serveStdio"]],
    ["@kervan/transport/testing", "../src/testing.js", ["createTestClient"]],
  ])("%s exports exactly these values", async (_name, path, expected) => {
    expect(Object.keys(await import(path)).sort()).toEqual(expected)
  })
})
