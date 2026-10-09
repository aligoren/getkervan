// How the docs example runner reads a documented command (scripts/site/run-examples.mjs): the
// placeholders for a clone's location in the published text map to the real clone when it runs.
import path from "node:path"
import { describe, expect, it } from "vitest"
import { commandLines, runExamples, toProcess, words } from "../site/run-examples.mjs"

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

  // The connect command is a Claude Code command whether it installs from source or from npm;
  // without --claude it is not run (CI has no `claude` CLI), in both kinds.
  it.each(["source", "published"])(
    "skips a %s block that is a Claude Code command without --claude",
    async (check) => {
      const block = {
        page: "/docs/framework/quickstart/",
        check,
        raw: "claude mcp add open-meteo -- npx kervan@next run /absolute/path/to/kervan.yaml",
        attrs: {},
      }
      // With --network, so a source block is not skipped for the network first.
      const results = await runExamples([block], {
        network: true,
        published: check === "published",
        log: () => {},
      })
      expect(results).toEqual([
        expect.objectContaining({ status: "skipped", detail: expect.stringContaining("--claude") }),
      ])
    },
  )
})
