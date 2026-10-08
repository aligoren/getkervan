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
const exampleTs = read("examples/calculator/src/calculator.ts")

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
type Options = { exampleSpec?: string; exampleTs?: string; published?: boolean }
const check = (overrides: Overrides = {}, options: Options = {}) =>
  checkBuild(
    siteView(dir, overrides),
    { ...params, ...(options.published === undefined ? {} : { published: options.published }) },
    {
      exampleSpec: options.exampleSpec ?? exampleSpec,
      exampleTs: options.exampleTs ?? exampleTs,
    },
  )
const page = (file: string) => readFileSync(path.join(dir, file), "utf8")
/** The errors that `change` causes and the unchanged build does not have. */
const newErrors = (overrides: Overrides, options: Options = {}) => {
  const before = new Set(check().errors)
  return check(overrides, options).errors.filter((error) => !before.has(error))
}

run("the built site", () => {
  it("passes every check:site rule (only the placeholder warnings remain)", () => {
    const result = check()
    expect(result.errors).toEqual([])
    // Pages not committed yet have no git date; in a clean clone there are none.
    for (const warning of result.warnings) expect(warning).toMatch(/placeholder|no lastmod/)
  })

  it("has the framework's concept pages, the TypeScript group and the Studio page", () => {
    const sitemap = page("sitemap.xml")
    for (const url of [
      "/docs/framework/how-kervan-works/",
      "/docs/framework/yaml-or-typescript/",
      "/docs/framework/errors/",
      "/docs/framework/middleware/",
      "/docs/framework/registry/",
      "/docs/framework/testing/",
      "/studio/",
    ]) {
      expect(sitemap).toContain(`<loc>https://getkervan.dev${url}</loc>`)
    }
    // The framework menu, in its groups, in this order.
    const nav =
      /<nav class="?docs-nav"?[\s\S]*?<\/nav>/.exec(page("docs/framework/api/index.html"))?.[0] ??
      ""
    const groups = [
      ...nav.matchAll(
        /<details class="?nav-group"?( open)?>\s*<summary>([^<]+)<\/summary>([\s\S]*?)<\/details>/g,
      ),
    ].map((match) => ({ name: match[2], open: Boolean(match[1]), body: match[3] }))
    expect(groups.map((group) => group.name)).toEqual([
      "Start",
      "Concepts",
      "Build with YAML",
      "Build with TypeScript",
      "Run and operate",
      "Guides",
      "More",
    ])
    // The current page's group is open, every other one closed (but its links are in the HTML).
    expect(groups.filter((group) => group.open).map((group) => group.name)).toEqual([
      "Build with TypeScript",
    ])
    const typescript = groups.find((group) => group.name === "Build with TypeScript")?.body ?? ""
    const names = [...typescript.matchAll(/<a [^>]*>([^<]+)<\/a>/g)].map((match) => match[1])
    expect(names.at(-1)).toBe("Programmatic API")
    expect(names).toEqual(
      expect.arrayContaining(["Tools in TypeScript", "Errors", "Middleware", "Testing"]),
    )
    expect(groups.find((group) => group.name === "Guides")?.body).toMatch(
      /href="?\/guides\/what-is-mcp\/"?/,
    )
  })

  it("groups the Studio book's menu, with the current page's group open", () => {
    const nav =
      /<nav class="?docs-nav"?[\s\S]*?<\/nav>/.exec(page("docs/studio/audit/index.html"))?.[0] ?? ""
    const summaries = [
      ...nav.matchAll(/<details class="?nav-group"?( open)?>\s*<summary>([^<]+)<\/summary>/g),
    ]
    expect(summaries.map((match) => match[2])).toEqual([
      "Start",
      "Servers",
      "People and logs",
      "Operate",
      "Guides",
      "More",
    ])
    expect(summaries.filter((match) => match[1]).map((match) => match[2])).toEqual([
      "People and logs",
    ])
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
      "no noindex for preview hosts",
      () => ({
        _headers: page("_headers").replaceAll("X-Robots-Tag: noindex", "X-Robots-Tag: all"),
      }),
      /no X-Robots-Tag noindex for https:\/\/:project\.pages\.dev/,
    ],
    [
      "a short HSTS",
      () => ({
        _headers: page("_headers").replace(/max-age=\d+/, "max-age=86400"),
      }),
      /no Strict-Transport-Security of at least a year/,
    ],
    [
      "a canonical link on the 404 page",
      () => ({
        "404.html": page("404.html").replace(
          "</head>",
          '<link rel="canonical" href="https://getkervan.dev/404.html"></head>',
        ),
      }),
      /the 404 page has a canonical link/,
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
      "a Studio screenshot in the first screen",
      () => ({
        "index.html": home().replace(
          "</section>",
          '<img src="/screenshots/editor-light.webp" alt="x" width="1" height="1"></section>',
        ),
      }),
      /a Studio screenshot in the first screen/,
    ],
    [
      "a lazy image in the hero",
      () => ({
        "index.html": home().replace(
          "</section>",
          '<img src="/favicon.svg" alt="" width="1" height="1" loading="lazy"></section>',
        ),
      }),
      /lazy-loaded/,
    ],
    [
      "more than two Studio screenshots",
      () => ({
        "index.html": inMain(
          home(),
          '<img src="/screenshots/calls-light.webp" alt="x" width="1" height="1" loading="lazy"><img src="/screenshots/audit-dark.webp" alt="x" width="1" height="1" loading="lazy">',
        ),
      }),
      /Studio screenshots .*; at most 2/,
    ],
    [
      "a code block the keyboard cannot scroll",
      () => ({
        "docs/framework/quickstart/index.html": docs().replace(
          /(<pre[^>]*?) aria-label=("[^"]*"|[^\s>]+)/,
          "$1",
        ),
      }),
      /a <pre> without tabindex="0", a role and an aria-label/,
    ],
    [
      "every menu group open",
      () => ({
        "docs/framework/quickstart/index.html": docs().replace(
          /<details class="?nav-group"?>/g,
          '<details class="nav-group" open>',
        ),
      }),
      /open group\(s\); exactly the current page's should be/,
    ],
    [
      "the current page's group closed",
      () => ({
        "docs/framework/quickstart/index.html": docs().replace(
          /<details class="?nav-group"? open>/,
          '<details class="nav-group">',
        ),
      }),
      /0 open group\(s\)/,
    ],
    [
      "an open group on a page the menu does not list",
      () => ({
        "docs/index.html": page("docs/index.html").replace(
          /<details class="?nav-group"?>/,
          '<details class="nav-group" open>',
        ),
      }),
      /opens a group although this page is not in it/,
    ],
    [
      "two entries marked as the current page",
      () => ({
        "docs/framework/quickstart/index.html": docs().replace(
          /(<a href="?\/docs\/framework\/"?)>/,
          '$1 aria-current="page">',
        ),
      }),
      /the menu marks 2 entries as the current page/,
    ],
    [
      "a page twice in the menu",
      () => ({
        "docs/framework/quickstart/index.html": docs().replace(
          /(<summary>More<\/summary>\s*<ul>)/,
          '$1<li><a href="/docs/framework/errors/">Errors</a></li>',
        ),
      }),
      /lists \/docs\/framework\/errors\/ more than once/,
    ],
    [
      "navigation in On this page",
      () => ({
        "docs/framework/quickstart/index.html": docs().replace(
          /(<nav id="?TableOfContents"?><ul>)/,
          '$1<li><a href="#next">Next</a></li>',
        ),
      }),
      /"On this page" lists "Next", a navigation item/,
    ],
    [
      "a framework page without its Where this fits line",
      () => ({
        "docs/framework/quickstart/index.html": docs().replace(/<p class="?fits"?>/, "<p>"),
      }),
      /no "Where this fits" line/,
    ],
    [
      "a real drive-letter path",
      () => ({ "index.html": inMain(home(), "<p>D:\\Projects\\demo\\examples</p>") }),
      /index\.html: shows a drive-letter path/,
    ],
    [
      "a home folder in a JSON file",
      () => ({ "search/extra.json": JSON.stringify({ text: "see /home/sam/kervan/examples" }) }),
      /search\/extra\.json: shows a home folder path/,
    ],
    [
      "a landing spec excerpt that is not the file's beginning",
      () => ({ "index.html": home().replace("specVersion", "specVersions") }),
      /the spec excerpt is not the beginning/,
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

  it("a landing page TypeScript example that differs from the repository's file", () => {
    expect(newErrors({}, { exampleTs: exampleTs.replace("calculator", "calc") })).toEqual([
      "/: the TypeScript shown differs from examples/calculator/src/calculator.ts.",
    ])
  })

  it("accepts the placeholder paths the docs use, and JSON escapes that only look like paths", () => {
    const placeholder = inMain(
      page("index.html"),
      "<p>node C:\\path\\to\\kervan\\packages\\cli\\bin\\kervan.js and /absolute/path/to/kervan/x</p>",
    )
    expect(
      newErrors({
        "index.html": placeholder,
        // As raw JSON text this reads "x:\nfoo\nbar", a drive path to a naive scan.
        "extra.json": JSON.stringify({ help: "Options x:\nfoo\nbar" }),
      }),
    ).toEqual([])
  })

  it("a landing page spec that differs from examples/spec/kervan.yaml", () => {
    // The excerpt shown above the full file is checked against the file too.
    expect(newErrors({}, { exampleSpec: exampleSpec.replace("open-meteo", "other") })).toEqual([
      "/: the spec shown differs from examples/spec/kervan.yaml.",
      "/: the spec excerpt is not the beginning of examples/spec/kervan.yaml.",
    ])
  })

  it("an npm command while the packages are not published", () => {
    const withNpm = inMain(
      page("changelog/index.html"),
      '<pre tabindex="0" role="group" aria-label="sh code"><code>npm create kervan@latest my-server</code></pre>',
    )
    expect(newErrors({ "changelog/index.html": withNpm }, { published: false })).toEqual([
      expect.stringContaining("shows an npm command (npm create kervan"),
    ])
    expect(newErrors({ "changelog/index.html": withNpm }, { published: true })).toEqual([])
  })
})
