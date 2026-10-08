// What the published texts say about runtimes: Kervan is tested on Node only. `toFetchHandler` is a
// standard Fetch API handler, but no test runs it on Cloudflare Workers, Deno or Bun, so no page,
// README or package description may say it runs there. A paragraph that names one of them must say
// what is not done (not tested, not supported, cannot). `bun` as a package manager is a different
// thing and is not checked here.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

/** Published texts: the site's pages and layouts, the READMEs, the packages' descriptions. */
const files = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "site/content",
    "site/layouts",
    "site/data",
    "README.md",
    "packages/*/README.md",
    "packages/*/package.json",
    "apps/studio/README.md",
    "docs/API.md",
  ],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter((file) => file && !file.startsWith("site/data/generated/"))

const RUNTIME = /\b(Cloudflare Workers|Workers, Deno|Deno|Bun)\b/
const NEGATION = /\b(not|cannot)\b/i

/**
 * Paragraphs (blank-line separated; in HTML, each paragraph or list item) that name a fetch runtime
 * without saying what is not done.
 */
function claims(text: string): string[] {
  return text
    .split(/\r?\n\s*\r?\n|<\/p>|<\/li>/)
    .filter((paragraph) => RUNTIME.test(paragraph) && !NEGATION.test(paragraph))
    .map((paragraph) => paragraph.trim().slice(0, 160))
}

describe("runtime claims", () => {
  it("are checked in the files that carry them (the check is not blind)", () => {
    expect(files).toEqual(
      expect.arrayContaining([
        "README.md",
        "site/layouts/home.html",
        "packages/transport/README.md",
        "packages/transport/package.json",
        "site/content/docs/framework/deployment.md",
      ]),
    )
  })

  it("never say a runtime other than Node is supported", () => {
    const found = files.flatMap((file) =>
      claims(readFileSync(path.join(root, file), "utf8")).map((text) => `${file}: ${text}`),
    )
    expect(found).toEqual([])
  })

  it("would catch the claim it was written for", () => {
    expect(
      claims(
        "<h3>Fetch runtimes</h3><p>The same app as a fetch handler for Cloudflare Workers, Deno and Bun.</p>",
      ),
    ).toHaveLength(1)
    expect(claims("Tested on Node only; Workers, Deno and Bun are not tested.")).toEqual([])
  })
})
