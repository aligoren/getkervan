// The calculator example runs as written (Node.js strips the types) and prints the tool's result.
// The website shows this file on its landing page and in the docs, unchanged.
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const file = fileURLToPath(new URL("../src/calculator.ts", import.meta.url))

describe("calculator example", () => {
  it("prints the sum the add tool returns", () => {
    const result = spawnSync(process.execPath, [file], { encoding: "utf8" })
    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("sum: 5\n")
  })
})
