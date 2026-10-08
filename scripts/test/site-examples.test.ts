// How the docs example runner reads a documented command (scripts/site/run-examples.mjs): the
// placeholders for a clone's location in the published text map to the real clone when it runs.
import path from "node:path"
import { describe, expect, it } from "vitest"
import { commandLines, toProcess, words } from "../site/run-examples.mjs"

const tree = path.resolve("/work/kervan")
const B = String.fromCharCode(92)

describe("the docs example runner", () => {
  it("maps both placeholder forms and repository paths to the clone it runs in", () => {
    const posix = toProcess(
      "node /absolute/path/to/kervan/packages/cli/bin/kervan.js run /absolute/path/to/kervan/examples/spec/kervan.yaml",
      tree,
    )
    const windows = toProcess(
      `node C:${B}path${B}to${B}kervan${B}packages${B}cli${B}bin${B}kervan.js run C:${B}path${B}to${B}kervan${B}examples${B}spec${B}kervan.yaml`,
      tree,
    )
    const relative = toProcess(
      "node packages/cli/bin/kervan.js run examples/spec/kervan.yaml",
      tree,
    )
    const expected = [
      process.execPath,
      path.join(tree, "packages", "cli", "bin", "kervan.js"),
      "run",
      path.join(tree, "examples", "spec", "kervan.yaml"),
    ]
    expect(posix.argv).toEqual(expected)
    expect(windows.argv).toEqual(expected)
    expect(relative.argv).toEqual(expected)
  })

  it("keeps leading NAME=value words as the environment and quoted words whole", () => {
    expect(toProcess('A_KEY=x node -e "console.log(1 + 2)"', tree)).toEqual({
      env: { A_KEY: "x" },
      argv: [process.execPath, "-e", "console.log(1 + 2)"],
    })
    expect(words(`claude mcp add --header 'Authorization: Bearer x' name`)).toEqual([
      "claude",
      "mcp",
      "add",
      "--header",
      "Authorization: Bearer x",
      "name",
    ])
  })

  it("joins continued lines and drops comments", () => {
    const continued = ["a \\", "  b # note", "", "# only a comment", 'c "#not" d'].join("\n")
    expect(commandLines(continued)).toEqual(["a  b", 'c "#not" d'])
  })
})
