// One repository address everywhere it is written: the root package.json is the source, and the
// published packages, the website, the GitHub files and the contributor documents follow it. The
// published packages also share one version, one release tag and the same public metadata.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const read = (file: string) => readFileSync(path.join(root, file), "utf8")
const json = (file: string) => JSON.parse(read(file))

const PUBLISHED = [
  "packages/core",
  "packages/transport",
  "packages/spec-runtime",
  "packages/cli",
  "packages/create-kervan",
]

/** The repository's web address, from the root package.json: "https://github.com/<owner>/<name>". */
const repository = /^git\+(https:\/\/github\.com\/[\w.-]+\/[\w.-]+)\.git$/.exec(
  json("package.json").repository.url,
)?.[1]
const owner = repository?.split("/")[3]

describe("the repository address", () => {
  it("is set in the root package.json", () => {
    expect(repository).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/)
    expect(json("package.json").bugs.url).toBe(`${repository}/issues`)
  })

  it.each(PUBLISHED)("%s points at it, with its own directory", (dir) => {
    const manifest = json(`${dir}/package.json`)
    expect(manifest.repository).toEqual({
      type: "git",
      url: `git+${repository}.git`,
      directory: dir,
    })
    expect(manifest.bugs).toEqual({ url: `${repository}/issues` })
    expect(manifest.homepage).toBe("https://getkervan.dev")
  })

  it("is the website's source link (params.repoURL, the only place the site takes it from)", () => {
    expect(read("site/hugo.toml")).toContain(`repoURL = "${repository}"`)
  })

  it("names its owner in CODEOWNERS and its reporting form in the issue settings and SECURITY.md", () => {
    expect(read(".github/CODEOWNERS")).toMatch(new RegExp(`^\\*\\s+@${owner}$`, "m"))
    const form = `${repository}/security/advisories/new`
    expect(read(".github/ISSUE_TEMPLATE/config.yml")).toContain(`url: ${form}`)
    expect(read("SECURITY.md")).toContain(form)
    // The email channel stays: the form works only once the repository is public.
    expect(read("SECURITY.md")).toContain("security@getkervan.dev")
  })

  it("is what CONTRIBUTING.md and README.md clone", () => {
    for (const file of ["CONTRIBUTING.md", "README.md"]) {
      expect(read(file), file).toContain(`git clone ${repository}.git kervan`)
    }
  })

  it("leaves no placeholder in any tracked file", () => {
    const placeholders = ["REPLACE-WITH-" + "ORG", "OWNER/" + "REPO", "TODO-" + "owner"]
    // check-site.mjs names the old placeholder to warn about it; that is a rule, not a placeholder.
    const result = spawnSync(
      "git",
      [
        "grep",
        "-l",
        "-F",
        ...placeholders.flatMap((p) => ["-e", p]),
        "--",
        ".",
        ":!scripts/check-site.mjs",
      ],
      { cwd: root, encoding: "utf8" },
    )
    expect(result.status, result.stdout).toBe(1) // git grep: 1 means "no match"
    expect(result.stdout).toBe("")
  })
})

describe("the published packages", () => {
  const manifests = PUBLISHED.map((dir) => ({ dir, manifest: json(`${dir}/package.json`) }))

  it("share one version and are published to the next tag, publicly", () => {
    const versions = new Set(manifests.map(({ manifest }) => manifest.version))
    expect(versions.size).toBe(1)
    for (const { dir, manifest } of manifests) {
      expect(manifest.publishConfig, dir).toEqual({ access: "public", tag: "next" })
      expect(manifest.license, dir).toBe("MIT")
      expect(manifest.private, dir).toBeUndefined()
    }
  })

  it("name no person: the author is the project, with no email", () => {
    for (const { dir, manifest } of manifests) {
      expect(manifest.author, dir).toEqual({
        name: "Kervan contributors",
        url: "https://getkervan.dev",
      })
      expect(JSON.stringify(manifest), dir).not.toMatch(
        /@[\w-]+\.[a-z]{2,}(?!\/)|[A-Za-z]:\\|\/home\/|\/Users\//,
      )
    }
  })

  it("list the files they ship, and never their sources, tests or source maps", () => {
    for (const { dir, manifest } of manifests) {
      expect(manifest.files, dir).not.toContain("src")
      expect(
        manifest.files.some((entry: string) => /test/.test(entry)),
        dir,
      ).toBe(false)
      if (manifest.files.includes("dist")) expect(manifest.files, dir).toContain("!dist/**/*.map")
    }
  })

  it("have READMEs that work on npm: a documentation link, no relative links, no dead site pages", () => {
    for (const { dir } of manifests) {
      const readme = read(`${dir}/README.md`)
      expect(readme, dir).toContain("(https://getkervan.dev/docs/framework/)")
      // npm shows the README away from the repository, where a relative link leads nowhere.
      expect(readme, dir).not.toMatch(/\]\((?!https:\/\/|#)/)
      for (const [, page] of readme.matchAll(
        /https:\/\/getkervan\.dev\/docs\/framework\/([\w-]+)\//g,
      )) {
        expect(
          existsSync(path.join(root, "site", "content", "docs", "framework", `${page}.md`)),
          page,
        ).toBe(true)
      }
      // The note stays until release day; the publish guard refuses while it is there.
      expect(readme, dir).toContain("**Not published yet.**")
    }
  })

  it("carry the shared keywords", () => {
    for (const { dir, manifest } of manifests) {
      expect(manifest.keywords, dir).toEqual(
        expect.arrayContaining(["mcp", "model-context-protocol"]),
      )
    }
  })
})
