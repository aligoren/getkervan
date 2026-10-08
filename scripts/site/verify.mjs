// `pnpm site:verify`: the website's slow checks, which `pnpm test` leaves out.
//
// 1. Builds the site (scripts/site/build.mjs) and runs check:site on it.
// 2. Serves the build with its `_headers` (scripts/site/serve.mjs, so Chromium enforces the real
//    CSP) and opens every page light and dark, at desktop and phone width:
//    - axe-core finds no WCAG 2.2 A/AA or best-practice violation (contrast included);
//    - the CSP blocks nothing, no request leaves the local server, nothing logs an error;
//    - nothing scrolls sideways on a phone.
//    Without JavaScript: the theme switch works, the skip link is the first Tab stop and shows,
//    the search page lists every page. With it: copy buttons appear and search finds pages.
//    The home page with the images Chromium loads stays within the budget, measured in the browser.
// 3. With --examples, runs the documentation's code blocks (scripts/site/run-examples.mjs; also
//    --network, --claude, --docker).
//
// --shots <dir> saves a picture of the home page and three docs pages in each variant.
// --skip-build checks site/public as it is; --skip-check leaves out check:site (to test the
// browser checks on their own).
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "@playwright/test"
import { BUDGET, siteParams, siteView } from "../check-site.mjs"
import { collectBlocks } from "./docs-examples.mjs"
import { runExamples } from "./run-examples.mjs"
import { startStatic } from "./serve.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const publicDir = path.join(root, "site", "public")
const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)

const VARIANTS = [
  { name: "desktop-light", viewport: { width: 1440, height: 900 }, colorScheme: "light" },
  { name: "desktop-dark", viewport: { width: 1440, height: 900 }, colorScheme: "dark" },
  { name: "phone-light", viewport: { width: 390, height: 844 }, colorScheme: "light" },
  { name: "phone-dark", viewport: { width: 390, height: 844 }, colorScheme: "dark" },
]
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"]
const SHOT_PAGES = [
  "/",
  "/docs/framework/quickstart/",
  "/docs/framework/spec-reference/",
  "/docs/studio/install/",
]

function step(name, argv) {
  console.log(`\n== ${name}`)
  const result = spawnSync(process.execPath, argv, { cwd: root, stdio: "inherit" })
  if (result.status !== 0) {
    console.error(`${name} failed.`)
    process.exit(1)
  }
}

/** Opens a page and collects what went wrong: errors, CSP reports, requests to other origins. */
async function open(context, origin, urlPath) {
  const page = await context.newPage()
  const problems = []
  page.on("console", (message) => {
    // The 404 page's own status is reported by Chromium as a failed load: that one is expected.
    const expected404 =
      urlPath === "/404-check/" &&
      /status of 404/.test(message.text()) &&
      message.location().url === origin + urlPath
    if (message.type() === "error" && !expected404)
      problems.push(`console error: ${message.text()}`)
  })
  page.on("pageerror", (error) => problems.push(`script error: ${error.message}`))
  page.on("request", (request) => {
    if (!request.url().startsWith(origin) && !request.url().startsWith("data:"))
      problems.push(`request to ${request.url()}`)
  })
  await page.addInitScript(() => {
    window.__cspViolations = []
    document.addEventListener("securitypolicyviolation", (event) => {
      window.__cspViolations.push(
        `${event.violatedDirective} blocked ${event.blockedURI || "inline code"}`,
      )
    })
  })
  const response = await page.goto(origin + urlPath, { waitUntil: "load" })
  const expected = urlPath === "/404-check/" ? 404 : 200
  if (response?.status() !== expected)
    problems.push(`status ${response?.status()}, expected ${expected}`)
  return { page, problems }
}

async function browserChecks(origin, pages, shotsDir) {
  const failures = []
  const fail = (where, problem) => failures.push(`${where}: ${problem}`)
  const axeSource = readFileSync(path.join(root, "node_modules", "axe-core", "axe.min.js"), "utf8")
  const browser = await chromium.launch()
  try {
    for (const variant of VARIANTS) {
      const context = await browser.newContext({
        viewport: variant.viewport,
        colorScheme: variant.colorScheme,
        reducedMotion: "reduce",
      })
      for (const urlPath of [...pages, "/404-check/"]) {
        const where = `${urlPath} (${variant.name})`
        const { page, problems } = await open(context, origin, urlPath)
        // axe-core is evaluated through the DevTools protocol, which the page's CSP does not cover.
        await page.evaluate(axeSource)
        const result = await page.evaluate(
          (tags) => window.axe.run(document, { runOnly: { type: "tag", values: tags } }),
          AXE_TAGS,
        )
        for (const violation of result.violations) {
          const targets = violation.nodes
            .slice(0, 3)
            .map((node) => node.target.join(" "))
            .join(", ")
          fail(where, `axe ${violation.id} (${violation.impact}): ${violation.help} at ${targets}`)
        }
        problems.push(
          ...(await page.evaluate(() => window.__cspViolations)).map((text) => `CSP: ${text}`),
        )
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        )
        if (overflow > 1) problems.push(`scrolls sideways by ${overflow}px`)
        for (const problem of problems) fail(where, problem)
        if (shotsDir && SHOT_PAGES.includes(urlPath)) {
          // Lazy images load only once scrolled to: scroll through, then wait for every image.
          await page.evaluate(async () => {
            for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight) {
              window.scrollTo(0, y)
              await new Promise((resolve) => setTimeout(resolve, 50))
            }
            window.scrollTo(0, 0)
            await Promise.all([...document.images].map((image) => image.decode().catch(() => {})))
          })
          const name =
            urlPath === "/" ? "home" : urlPath.replace(/^\/|\/$/g, "").replaceAll("/", "-")
          await page.screenshot({
            path: path.join(shotsDir, `${name}-${variant.name}.png`),
            fullPage: true,
          })
        }
        await page.close()
      }
      await context.close()
    }

    // Without JavaScript: the theme switch, the skip link, the page list on the search page.
    const plain = await browser.newContext({
      javaScriptEnabled: false,
      colorScheme: "light",
      viewport: { width: 1440, height: 900 },
    })
    {
      const { page } = await open(plain, origin, "/docs/framework/quickstart/")
      await page.keyboard.press("Tab")
      const skip = await page.evaluate(() => {
        const element = document.activeElement
        const box = element?.getBoundingClientRect()
        return {
          className: element?.className,
          visible: !!box && box.width > 0 && box.top >= 0 && box.bottom <= window.innerHeight,
        }
      })
      if (skip.className !== "skip-link" || !skip.visible)
        fail("skip link", `the first Tab stop is "${skip.className}", visible: ${skip.visible}`)
      const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor)
      const light = await background()
      await page.locator('label[for="theme-dark"]').click()
      const dark = await background()
      if (light === dark)
        fail("theme switch (no JavaScript)", `the background stays ${light} after choosing Dark`)
      await page.locator('label[for="theme-light"]').click()
      if ((await background()) !== light)
        fail(
          "theme switch (no JavaScript)",
          "choosing Light does not bring the light background back",
        )
      await page.close()
      const search = await open(plain, origin, "/search/")
      const listed = await search.page.locator("main").innerText()
      if (!listed.includes("All pages") || !listed.includes("Quickstart"))
        fail("search (no JavaScript)", "the page list is missing")
      await search.page.close()
    }
    await plain.close()

    // With JavaScript: copy buttons, search, and the home page's first load.
    const scripted = await browser.newContext({
      colorScheme: "light",
      viewport: { width: 1440, height: 900 },
    })
    {
      const { page } = await open(scripted, origin, "/docs/framework/quickstart/")
      if ((await page.locator(".code.has-copy button").count()) === 0)
        fail("copy buttons", "none on the quickstart")
      await page.close()
      const search = await open(scripted, origin, "/search/")
      await search.page.locator('input[type="search"]').fill("secrets")
      await search.page.waitForTimeout(300)
      const hits = await search.page.locator("#search-results a").count()
      if (hits === 0) fail("search", 'no result for "secrets"')
      await search.page.close()
    }
    await scripted.close()

    const fresh = await browser.newContext({
      colorScheme: "light",
      viewport: { width: 1440, height: 900 },
    })
    {
      const page = await fresh.newPage()
      // Every response's body, awaited: Chromium also fetches lazy images near the viewport, so
      // this is the page with its images (check:site budgets the first load statically).
      const sizes = []
      page.on("response", (response) => {
        sizes.push(
          response.body().then(
            (body) => body.length,
            () => 0,
          ),
        )
      })
      await page.goto(`${origin}/`, { waitUntil: "networkidle" })
      const bytes = (await Promise.all(sizes)).reduce((sum, size) => sum + size, 0)
      console.log(
        `home page in the browser, with the images it loaded: ${bytes} bytes (budget ${BUDGET.homeWithImages})`,
      )
      if (bytes > BUDGET.homeWithImages)
        fail("/", `the page with its images is ${bytes} bytes, over ${BUDGET.homeWithImages}`)
      await page.close()
    }
    await fresh.close()
  } finally {
    await browser.close()
  }
  return failures
}

async function main() {
  if (!flag("--skip-build")) step("build", ["scripts/site/build.mjs"])
  if (!flag("--skip-check")) step("check:site", ["scripts/check-site.mjs"])
  const view = siteView(publicDir)
  const pages = [...view.files]
    .filter((file) => file.endsWith("index.html"))
    .map((file) => `/${file.replace(/index\.html$/, "")}`)
    .sort()
  const shotsDir = option("--shots") ? path.resolve(option("--shots")) : undefined
  if (shotsDir) mkdirSync(shotsDir, { recursive: true })

  console.log(`\n== browser: ${pages.length} pages x ${VARIANTS.length} variants`)
  const server = await startStatic(publicDir, 0)
  let failures
  try {
    failures = await browserChecks(server.url, pages, shotsDir)
  } finally {
    await server.close()
  }
  for (const failure of failures) console.error(`error: ${failure}`)
  if (failures.length === 0) console.log("browser checks passed.")

  let exampleFailures = 0
  if (flag("--examples")) {
    console.log("\n== documentation examples")
    const params = siteParams(readFileSync(path.join(root, "site", "hugo.toml"), "utf8"))
    const results = await runExamples(collectBlocks(view), {
      network: flag("--network"),
      claude: flag("--claude"),
      docker: flag("--docker"),
      published: params.published === true,
    })
    const failed = results.filter((result) => result.status === "failed")
    for (const result of failed) console.error(`\nFAILED ${result.where}\n${result.detail}`)
    const count = (status) => results.filter((result) => result.status === status).length
    console.log(`examples: ${count("ok")} ok, ${count("skipped")} skipped, ${failed.length} failed`)
    exampleFailures = failed.length
  }
  if (failures.length > 0 || exampleFailures > 0) process.exit(1)
  console.log("\nsite:verify passed.")
}

await main()
