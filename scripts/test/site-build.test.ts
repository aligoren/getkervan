// The built website: Hugo builds it into a temporary folder and check:site's rules run on it. Each
// rule is also shown to catch the problem it is for, by changing one built file (`siteView`'s
// overrides) and expecting that rule's error. The design tokens are Studio's, and the code blocks
// declare how they are verified (scripts/site/docs-examples.mjs).
//
// Needs Hugo at the pinned version (site/.hugo-version). Without it these tests are skipped, unless
// KERVAN_REQUIRE_HUGO=1 (the site's CI job), where a missing Hugo fails them.
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire, stripTypeScriptTypes } from "node:module"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { checkBuild, siteParams, siteView } from "../check-site.mjs"
import { hugoProblem, pinnedHugoVersion } from "../site/build.mjs"
import { codeOf, collectBlocks, declarationProblems } from "../site/docs-examples.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const read = (file: string) => readFileSync(path.join(root, file), "utf8")

const probe = spawnSync("hugo", ["version"], { encoding: "utf8" })
const problem = hugoProblem(probe.error ? undefined : probe.stdout, pinnedHugoVersion())
const required = process.env.KERVAN_REQUIRE_HUGO === "1"
const run = problem === undefined || required ? describe : describe.skip
if (problem !== undefined && !required) console.warn(`Skipping the built-site tests: ${problem}`)

let dir = ""
const params = siteParams(read("site/hugo.toml"))
const exampleSpec = read("examples/spec/kervan.yaml")

beforeAll(() => {
  if (problem !== undefined && !required) return
  if (problem !== undefined) throw new Error(problem)
  dir = mkdtempSync(path.join(tmpdir(), "kervan-site-"))
  const result = spawnSync(
    "hugo",
    [
      "--source",
      path.join(root, "site"),
      "--destination",
      dir,
      "--minify",
      "--panicOnWarning",
      "--quiet",
    ],
    { encoding: "utf8" },
  )
  if (result.status !== 0) throw new Error(`hugo failed: ${result.stderr}${result.stdout}`)
}, 120_000)

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

type Overrides = Record<string, string | null>
const check = (
  overrides: Overrides = {},
  options: { exampleSpec?: string; published?: boolean } = {},
) =>
  checkBuild(
    siteView(dir, overrides),
    { ...params, ...(options.published === undefined ? {} : { published: options.published }) },
    {
      exampleSpec: options.exampleSpec ?? exampleSpec,
    },
  )
const page = (file: string) => readFileSync(path.join(dir, file), "utf8")
/** The errors that `change` causes and the unchanged build does not have. */
const newErrors = (
  overrides: Overrides,
  options: { exampleSpec?: string; published?: boolean } = {},
) => {
  const before = new Set(check().errors)
  return check(overrides, options).errors.filter((error) => !before.has(error))
}

run("the built site", () => {
  it("passes every check:site rule (only the placeholder warnings remain)", () => {
    const result = check()
    expect(result.errors).toEqual([])
    for (const warning of result.warnings) expect(warning).toMatch(/placeholder/)
  })

  it("uses Studio's design tokens unchanged, for light, system dark and chosen dark", () => {
    const theme = read("apps/studio/web/src/ui/theme.css")
    const css = page([...siteView(dir).files].find((name) => /^css\/.*\.css$/.test(name)) ?? "")
    const declarations = (block: string) =>
      new Map(
        [...block.matchAll(/(--k-[\w-]+)\s*:\s*([^;]+);/g)].map((match) => [
          match[1],
          (match[2] ?? "").replace(/\s+/g, " ").trim(),
        ]),
      )
    const blockAfter = (text: string, selector: string) => {
      const start = text.indexOf(selector)
      if (start < 0) throw new Error(`no ${selector}`)
      const open = text.indexOf("{", start + selector.length - 1)
      return text.slice(open + 1, text.indexOf("}", open))
    }
    const pairs: [string, string][] = [
      ["\n:root {", ":root{"],
      [
        ':root:not([data-theme="light"]) {',
        ":root:not([data-theme=light]):not(:has(#theme-light:checked)){",
      ],
      [':root[data-theme="dark"] {', ":root[data-theme=dark],:root:has(#theme-dark:checked){"],
    ]
    for (const [source, built] of pairs) {
      const expected = declarations(blockAfter(theme, source))
      expect(expected.size).toBeGreaterThan(20)
      expect(declarations(`${blockAfter(css, built)};`)).toEqual(expected)
    }
  })

  it("documents how each code block is verified; specs load, fragments and excerpts parse", async () => {
    const blocks = collectBlocks(siteView(dir))
    expect(blocks.length).toBeGreaterThan(50)
    expect(declarationProblems(blocks)).toEqual([])

    const { loadSpec } = await import(
      pathToFileURL(path.join(root, "packages/spec-runtime/dist/index.js")).href
    )
    const yaml = createRequire(path.join(root, "packages/spec-runtime/package.json"))("yaml")
    const specs = blocks.filter((block) => block.check === "spec")
    expect(specs.length).toBeGreaterThanOrEqual(4)
    for (const block of specs) {
      await expect(loadSpec(codeOf(block)), `${block.page}`).resolves.toBeDefined()
    }
    for (const block of blocks.filter((block) => block.check === "fragment")) {
      const parsed = yaml.parseDocument(codeOf(block))
      expect(parsed.errors, `${block.page}: ${codeOf(block)}`).toEqual([])
    }
    const scratch = mkdtempSync(path.join(tmpdir(), "kervan-site-ts-"))
    try {
      for (const [index, block] of blocks
        .filter((block) => block.check?.startsWith("ts"))
        .entries()) {
        const file = path.join(scratch, `block-${index}.mjs`)
        writeFileSync(file, stripTypeScriptTypes(codeOf(block)))
        const parsed = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" })
        expect(parsed.status, `${block.page}: ${parsed.stderr}`).toBe(0)
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it("the declaration rules catch an undeclared block, a manual block without a reason and a missing spec", () => {
    const html = page("docs/framework/quickstart/index.html")
    const undeclared = html.replace(/ data-check="?run"?/, "")
    expect(
      declarationProblems(
        collectBlocks(siteView(dir, { "docs/framework/quickstart/index.html": undeclared })),
      ),
    ).toEqual([expect.stringContaining("does not say how it is verified")])
    const guide = page("guides/mcp-server-from-yaml/index.html")
    const noSpec = guide.replace(/ data-id="?hn"?/, "")
    expect(
      declarationProblems(
        collectBlocks(siteView(dir, { "guides/mcp-server-from-yaml/index.html": noSpec })),
      ).length,
    ).toBeGreaterThan(0)
    const secrets = page("docs/framework/secrets/index.html")
    const noReason = secrets.replace(/ data-reason=("[^"]*"|\S+)/, "")
    expect(
      declarationProblems(
        collectBlocks(siteView(dir, { "docs/framework/secrets/index.html": noReason })),
      ),
    ).toEqual([expect.stringContaining("needs a reason")])
  })
})

/** Inserts `html` just before `</main>` of a page. */
const inMain = (html: string, extra: string) => html.replace("</main>", `${extra}</main>`)

run("each check:site rule catches its problem", () => {
  const home = () => page("index.html")
  const docs = () => page("docs/framework/quickstart/index.html")
  const cases: [string, () => Overrides, RegExp][] = [
    [
      "a script from another site",
      () => ({
        "index.html": inMain(home(), '<script src="https://cdn.example.com/a.js"></script>'),
      }),
      /loads https:\/\/cdn\.example\.com/,
    ],
    [
      "a stylesheet from another site",
      () => ({
        "index.html": home().replace(
          "</head>",
          '<link rel="stylesheet" href="https://fonts.example.com/x.css"></head>',
        ),
      }),
      /<link> loads/,
    ],
    [
      "an image from another site",
      () => ({
        "index.html": inMain(
          home(),
          '<img src="//img.example.com/a.png" alt="" width="1" height="1">',
        ),
      }),
      /<img> loads/,
    ],
    [
      "an inline script",
      () => ({ "index.html": inMain(home(), "<script>alert(1)</script>") }),
      /an inline <script>/,
    ],
    [
      "a style attribute",
      () => ({ "index.html": inMain(home(), '<p style="color:red">x</p>') }),
      /a style attribute/,
    ],
    [
      "a <style> element",
      () => ({ "index.html": home().replace("</head>", "<style>p{}</style></head>") }),
      /a <style> element/,
    ],
    [
      "an inline event handler",
      () => ({ "index.html": inMain(home(), '<a href="/" onclick="x()">x</a>') }),
      /inline event handler/,
    ],
    [
      "an iframe",
      () => ({ "index.html": inMain(home(), '<iframe src="/"></iframe>') }),
      /<iframe> is not allowed/,
    ],
    [
      "an image without alt",
      () => ({ "index.html": inMain(home(), '<img src="/favicon.svg" width="1" height="1">') }),
      /without alt/,
    ],
    [
      "an image without size",
      () => ({ "index.html": inMain(home(), '<img src="/favicon.svg" alt="">') }),
      /without width and height/,
    ],
    [
      "a long title",
      () => ({
        "changelog/index.html": page("changelog/index.html").replace(
          /<title>[^<]*<\/title>/,
          `<title>${"A".repeat(70)}</title>`,
        ),
      }),
      /the title is 70 characters/,
    ],
    [
      "a repeated title",
      () => ({
        "changelog/index.html": page("changelog/index.html").replace(
          /<title>[^<]*<\/title>/,
          /<title>[^<]*<\/title>/.exec(docs())?.[0] ?? "",
        ),
      }),
      /is used by/,
    ],
    [
      "a short description",
      () => ({
        "changelog/index.html": page("changelog/index.html").replace(
          /<meta name="?description"? content="[^"]*"/,
          '<meta name="description" content="Too short."',
        ),
      }),
      /the description is 10 characters/,
    ],
    [
      "a second h1",
      () => ({ "changelog/index.html": inMain(page("changelog/index.html"), "<h1>Again</h1>") }),
      /2 <h1> elements/,
    ],
    [
      "a skipped heading level",
      () => ({ "changelog/index.html": inMain(page("changelog/index.html"), "<h4>Deep</h4>") }),
      /<h4> follows an <h\d>/,
    ],
    [
      "no lang",
      () => ({
        "changelog/index.html": page("changelog/index.html").replace(/<html lang="?en"?/, "<html"),
      }),
      /no lang="en"/,
    ],
    [
      "a wrong canonical",
      () => ({
        "changelog/index.html": page("changelog/index.html").replace(
          /<link rel="?canonical"?[^>]*>/,
          '<link rel="canonical" href="https://getkervan.dev/other/">',
        ),
      }),
      /canonical is https:\/\/getkervan\.dev\/other\//,
    ],
    [
      "a missing Open Graph image",
      () => ({
        "changelog/index.html": page("changelog/index.html").replace(
          /(property="?og:image"? content="https:\/\/getkervan\.dev\/)[^"]*/,
          "$1og/none.png",
        ),
      }),
      /og:image og\/none\.png does not exist/,
    ],
    [
      "a rating in JSON-LD",
      () => ({
        "index.html": home().replace(
          '"@type":"SoftwareApplication"',
          '"@type":"SoftwareApplication","aggregateRating":{"ratingValue":5}',
        ),
      }),
      /"aggregateRating"/,
    ],
    [
      "no breadcrumb on a docs page",
      () => ({
        "changelog/index.html": page("changelog/index.html").replace(
          /"@type":"BreadcrumbList"/,
          '"@type":"Thing"',
        ),
      }),
      /no BreadcrumbList/,
    ],
    [
      "an external link without rel",
      () => ({ "index.html": inMain(home(), '<a href="https://example.com/">x</a>') }),
      /needs rel="noopener noreferrer"/,
    ],
    [
      "a broken internal link",
      () => ({ "index.html": inMain(home(), '<a href="/docs/nothing/">x</a>') }),
      /link to \/docs\/nothing\/, which does not exist/,
    ],
    [
      "a broken fragment",
      () => ({ "index.html": inMain(home(), '<a href="/changelog/#nowhere">x</a>') }),
      /no element with id "nowhere"/,
    ],
    [
      "an orphan page",
      () => ({ "docs/orphan/index.html": page("changelog/index.html") }),
      /\/docs\/orphan\/: no other page links to it/,
    ],
    [
      "a page left out of the sitemap",
      () => ({
        "sitemap.xml": page("sitemap.xml").replace(
          /<url><loc>https:\/\/getkervan\.dev\/changelog\/<\/loc>[\s\S]*?<\/url>/,
          "",
        ),
      }),
      /sitemap\.xml leaves out https:\/\/getkervan\.dev\/changelog\//,
    ],
    [
      "a disallowed path",
      () => ({ "robots.txt": `${page("robots.txt")}\nDisallow: /docs/\n` }),
      /robots\.txt disallows/,
    ],
    [
      "noindex for the production host",
      () => ({ _headers: `${page("_headers")}\n/*\n  X-Robots-Tag: noindex\n` }),
      /noindex for \/\*/,
    ],
    [
      "an inline-allowing CSP",
      () => ({
        _headers: page("_headers").replace(
          "script-src 'self'",
          "script-src 'self' 'unsafe-inline'",
        ),
      }),
      /allows inline code/,
    ],
    [
      "no CSP",
      () => ({ _headers: page("_headers").replace(/^\s+Content-Security-Policy:.*$/m, "") }),
      /the CSP for \/\* lacks default-src/,
    ],
    [
      "a stylesheet importing another site",
      () => ({ "css/extra.css": '@import url("https://fonts.example.com/a.css");' }),
      /css\/extra\.css: loads something/,
    ],
    [
      "too much JavaScript",
      () => ({
        "js/site.min.js": "x".repeat(6000),
        "index.html": inMain(home(), '<script src="/js/site.min.js" defer></script>'),
      }),
      /bytes of JavaScript, over/,
    ],
    [
      "a lazy LCP image",
      () => ({ "index.html": home().replace(/fetchpriority="?high"?/, 'loading="lazy"') }),
      /lazy-loaded/,
    ],
    [
      "a Studio mention in the framework docs",
      () => ({
        "docs/framework/quickstart/index.html": docs().replace(
          "</article>",
          "<p>Open Studio.</p></article>",
        ),
      }),
      /the framework docs mention "Studio"/,
    ],
    [
      "no Studio line",
      () => ({
        "docs/framework/index.html": page("docs/framework/index.html").replace(
          "Looking for the optional web UI?",
          "",
        ),
      }),
      /there must be exactly one/,
    ],
  ]
  it.each(cases)("%s", (_name, overrides, expected) => {
    const errors = newErrors(overrides())
    expect(errors, errors.join("\n")).toEqual(
      expect.arrayContaining([expect.stringMatching(expected)]),
    )
  })

  it("a landing page spec that differs from examples/spec/kervan.yaml", () => {
    expect(newErrors({}, { exampleSpec: exampleSpec.replace("open-meteo", "other") })).toEqual([
      "/: the spec shown differs from examples/spec/kervan.yaml.",
    ])
  })

  it("an npm command while the packages are not published (a warning; --strict fails on it)", () => {
    const withNpm = inMain(
      page("changelog/index.html"),
      "<pre><code>npm create kervan@latest my-server</code></pre>",
    )
    expect(check({ "changelog/index.html": withNpm }, { published: false }).warnings).toEqual(
      expect.arrayContaining([expect.stringContaining("shows an npm command (npm create kervan")]),
    )
    expect(
      check({ "changelog/index.html": withNpm }, { published: true }).warnings.join("\n"),
    ).not.toContain("npm command")
  })
})
