// How the docs example runner reads a documented command (scripts/site/run-examples.mjs): the
// placeholders for a clone's location in the published text map to the real clone when it runs.
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  commandLines,
  linkCliDependencies,
  runExamples,
  toProcess,
  words,
} from "../site/run-examples.mjs"

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

  // A TypeScript example resolves @kervan/* like a project that depends on them. One link per
  // package, straight to its real folder: a link to the CLI's node_modules failed on GitHub's
  // Windows runners, where pnpm makes symbolic links (ERR_MODULE_NOT_FOUND from the ESM resolver).
  it("links each of the CLI's dependencies straight to its real folder", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kervan-links-"))
    try {
      linkCliDependencies(dir)
      const modules = path.join(dir, "node_modules")
      expect(lstatSync(modules).isSymbolicLink()).toBe(false)
      const repo = path.join(import.meta.dirname, "..", "..")
      for (const name of ["core", "transport", "spec-runtime"]) {
        const link = path.join(modules, "@kervan", name)
        const real = realpathSync(path.join(repo, "packages", name))
        expect(lstatSync(link).isSymbolicLink(), name).toBe(true)
        expect(path.resolve(dir, readlinkSync(link)).replace(/[\\/]$/, ""), name).toBe(real)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  // The home page's transcript replays against the spec and the TypeScript it names (data-code);
  // before publishing, with the repository's packages. A TypeScript tool that lists differently fails.
  describe("a REPL transcript with data-code", () => {
    const assets = path.join(import.meta.dirname, "..", "..", "site", "assets", "examples")
    const read = (name: string) =>
      readFileSync(path.join(assets, name), "utf8").replace(/\r\n/g, "\n")
    const spec = read("home.yaml")
    const ts = read("home.ts")
    const [, name = "", description = ""] = /name: (\S+)\n\s+description: (.+)/.exec(spec) ?? []
    const blocks = (code: string) => [
      { page: "/", check: "spec", id: "kervan", raw: spec, attrs: { "data-id": "kervan" } },
      { page: "/", check: "ts", id: "server", raw: code, attrs: { "data-id": "server" } },
      {
        page: "/",
        check: "repl",
        raw: `kervan> tools\n  ${name}  ${description}`,
        attrs: { "data-spec": "kervan", "data-code": "server" },
      },
    ]
    const replay = async (code: string) =>
      (await runExamples(blocks(code), { log: () => {} })).find((result) =>
        result.where.includes("repl"),
      )

    it("passes when the TypeScript lists the same tool", async () => {
      expect(await replay(ts)).toEqual(expect.objectContaining({ status: "ok" }))
    }, 120_000)

    it("fails when it does not", async () => {
      expect(description.length).toBeGreaterThan(10)
      const other = ts.replace(description, "Something else.")
      expect(other).not.toBe(ts)
      expect(await replay(other)).toEqual(
        expect.objectContaining({
          status: "failed",
          detail: expect.stringContaining("did not print (server.ts)"),
        }),
      )
    }, 120_000)
  })
})
