// Checks of the website, kept out of `pnpm test`'s date-free assertions where they depend on time,
// and run on the built site (site/public, or --dir <dir>) for everything else:
//
// - security.txt: an error once Expires has passed, a warning when it is less than 30 days away or
//   more than a year ahead (RFC 9116 recommends less than a year).
// - site/static/schema/v1.json: an error when it differs from the package's schema.
// - The configuration: the GitHub URL is still a placeholder (warning; an error with --strict).
// - The built pages (when a build exists): unique titles and descriptions of the right length, one
//   h1, a sound heading order, canonical URLs, Open Graph tags and images, parseable structured
//   data without ratings or prices, sitemap and robots.txt, no noindex, no orphan page, internal
//   links that resolve, nothing loaded from other sites and nothing the CSP would block, images
//   with alt text and a size, the performance budget, no npm command while the packages are
//   unpublished, the framework docs free of "Studio" but for one line, and the landing page's spec
//   equal to the repository's example.
//
// `--strict` (CI and release day) fails on warnings too.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const DAY = 86_400_000
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** The fields of a security.txt (`Name: value` lines; comments and blank lines skipped). */
export function securityTxtFields(text) {
  return new Map(
    text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "" && !line.startsWith("#"))
      .map((line) => {
        const at = line.indexOf(": ")
        return [line.slice(0, at), line.slice(at + 2)]
      }),
  )
}

/** Checks security.txt's Expires against `now`. */
export function checkSecurityTxt(text, now = Date.now()) {
  const errors = []
  const warnings = []
  const expires = Date.parse(securityTxtFields(text).get("Expires") ?? "")
  if (Number.isNaN(expires)) {
    errors.push("security.txt has no valid Expires date.")
  } else if (expires <= now) {
    errors.push(
      `security.txt expired on ${new Date(expires).toISOString()}: set a new Expires date (at most a year ahead) and redeploy.`,
    )
  } else if (expires - now < 30 * DAY) {
    const days = Math.ceil((expires - now) / DAY)
    warnings.push(`security.txt expires in ${days} day(s): renew Expires soon.`)
  } else if (expires - now > 366 * DAY) {
    warnings.push("security.txt expires more than a year ahead; RFC 9116 recommends less.")
  }
  return { errors, warnings }
}

/** The exit code: 1 on errors, and with `strict` on warnings too. */
export function exitCode({ errors, warnings }, strict) {
  return errors.length > 0 || (strict && warnings.length > 0) ? 1 : 0
}

// ---------------------------------------------------------------------------------------------
// The site's configuration (site/hugo.toml)

/** `params` values of hugo.toml that the checks need (a small TOML reader, enough for them). */
export function siteParams(toml) {
  const value = (key) => {
    const match = new RegExp(`^\\s*${key}\\s*=\\s*(.+)$`, "m").exec(toml)
    if (!match) return undefined
    const raw = match[1].replace(/\s+#.*$/, "").trim()
    if (raw === "true" || raw === "false") return raw === "true"
    return raw.replace(/^"|"$/g, "")
  }
  return { baseURL: value("baseURL"), published: value("published"), repoURL: value("repoURL") }
}

export const REPO_PLACEHOLDER = "REPLACE-WITH-ORG"

export function checkConfig(params) {
  const errors = []
  const warnings = []
  if (params.baseURL !== "https://getkervan.dev/")
    errors.push(`baseURL is ${params.baseURL}, not https://getkervan.dev/.`)
  if (typeof params.published !== "boolean")
    errors.push("params.published is not set to true or false.")
  if (!params.repoURL || params.repoURL.includes(REPO_PLACEHOLDER)) {
    warnings.push(
      "params.repoURL in site/hugo.toml is still a placeholder: set the source repository's URL.",
    )
  }
  return { errors, warnings }
}

// ---------------------------------------------------------------------------------------------
// Reading the built site

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  mdash: "—",
  ndash: "–",
}

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name) => {
    if (name[0] === "#") {
      const code =
        name[1] === "x" || name[1] === "X"
          ? Number.parseInt(name.slice(2), 16)
          : Number(name.slice(1))
      return String.fromCodePoint(code)
    }
    return ENTITIES[name] ?? whole
  })
}

/** Every start tag of `name` (or all tags) with its attributes (quoted or not, as minified HTML has them). */
export function tags(html, name) {
  const found = []
  const pattern = name
    ? new RegExp(
        `<${name}(?=[\\s>/])((?:\\s+[^\\s=>/]+(?:=(?:"[^"]*"|'[^']*'|[^\\s>]+))?)*)\\s*/?>`,
        "gi",
      )
    : /<([a-z][a-z0-9-]*)((?:\s+[^\s=>/]+(?:=(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/gi
  for (const match of html.matchAll(pattern)) {
    const source = name ? match[1] : match[2]
    const attrs = {}
    for (const attr of (source ?? "").matchAll(/([^\s=>/]+)(?:=("[^"]*"|'[^']*'|[^\s>]+))?/g)) {
      const raw = attr[2] ?? ""
      attrs[attr[1].toLowerCase()] = decodeEntities(raw.replace(/^["']|["']$/g, ""))
    }
    found.push({ name: (name ?? match[1]).toLowerCase(), attrs, index: match.index ?? 0 })
  }
  return found
}

/** Text of an element's content, tags removed. */
export function textOf(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ""))
    .replace(/\s+/g, " ")
    .trim()
}

/** All files under `dir`, as paths relative to it with "/" separators. */
function listFiles(dir, base = "") {
  return readdirSync(path.join(dir, base)).flatMap((name) => {
    const relative = base ? `${base}/${name}` : name
    return statSync(path.join(dir, relative)).isDirectory() ? listFiles(dir, relative) : [relative]
  })
}

/**
 * A view of a built site: file names and contents, with `overrides` (tests change a page without
 * copying the site). `null` in overrides removes a file.
 */
export function siteView(dir, overrides = {}) {
  const files = new Set(listFiles(dir))
  for (const [name, content] of Object.entries(overrides)) {
    if (content === null) files.delete(name)
    else files.add(name)
  }
  const read = (name) => {
    if (name in overrides && overrides[name] !== null) return Buffer.from(overrides[name])
    return readFileSync(path.join(dir, name))
  }
  return {
    files,
    read,
    text: (name) => read(name).toString("utf8"),
    size: (name) => read(name).length,
  }
}

/** The URL path a page file is served at: "docs/x/index.html" -> "/docs/x/". */
function urlOf(file) {
  return `/${file.replace(/index\.html$/, "")}`
}

/** The file a site path is served from, or undefined. */
function fileFor(view, urlPath) {
  const clean = decodeURIComponent(urlPath.split("#")[0].split("?")[0])
  const candidates = clean.endsWith("/")
    ? [`${clean.slice(1)}index.html`]
    : [clean.slice(1), `${clean.slice(1)}/index.html`]
  return candidates.find((candidate) => view.files.has(candidate))
}

/** Width and height of a PNG (from its IHDR chunk). */
function pngSize(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return undefined
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

/** The performance budget (bytes). The landing page's numbers are also in docs/SITE.md. */
export const BUDGET = {
  initialLoad: 200 * 1024,
  lcpImage: 100 * 1024,
  css: 30 * 1024,
  jsPerPage: 5 * 1024,
  font: 50 * 1024,
  screenshot: 120 * 1024,
  homeWithImages: 600 * 1024,
  html: 150 * 1024,
}

const RANGES = { title: [10, 60], description: [120, 160] }
const FORBIDDEN_LD = [
  "aggregateRating",
  "review",
  "reviewRating",
  "ratingValue",
  "offers",
  "price",
  "priceCurrency",
  "award",
]
const NPM_COMMANDS =
  /\b(?:npm (?:create|init|install|i|exec)\s+(?:-[\w-]+\s+)*(?:@?kervan|create-kervan)|npx\s+(?:-[\w-]+\s+)*(?:kervan|create-kervan)|pnpm (?:add|dlx|create) (?:@?kervan|create-kervan)|yarn (?:add|create|dlx) (?:@?kervan|create-kervan))/i
export const STUDIO_LINE = "Looking for the optional web UI? See Studio docs."

/** Checks the built site. `params` from hugo.toml; `exampleSpec` is examples/spec/kervan.yaml. */
export function checkBuild(view, params, options = {}) {
  const errors = []
  const warnings = []
  const base = (params.baseURL ?? "https://getkervan.dev/").replace(/\/$/, "")
  const pages = [...view.files].filter((file) => file.endsWith(".html")).sort()
  const titles = new Map()
  const descriptions = new Map()
  const canonicals = new Set()
  const linkedFrom = new Map()
  const ids = new Map()
  let studioLines = 0
  const placeholderPages = []

  for (const file of pages) {
    const html = view.text(file)
    ids.set(
      file,
      new Set(
        tags(html)
          .map((tag) => tag.attrs.id)
          .filter(Boolean),
      ),
    )
  }

  for (const file of pages) {
    const html = view.text(file)
    const where = urlOf(file)
    const is404 = file === "404.html"
    if (view.size(file) > BUDGET.html)
      errors.push(
        `${where}: the HTML is ${view.size(file)} bytes, over the ${BUDGET.html}-byte budget.`,
      )
    if (!/<html lang="?en"?[\s>]/.test(html)) errors.push(`${where}: <html> has no lang="en".`)

    const titleMatches = [...html.matchAll(/<title>([\s\S]*?)<\/title>/g)]
    const title = titleMatches.length === 1 ? textOf(titleMatches[0][1]) : ""
    if (titleMatches.length !== 1) errors.push(`${where}: ${titleMatches.length} <title> elements.`)
    else if (title.length < RANGES.title[0] || title.length > RANGES.title[1]) {
      errors.push(
        `${where}: the title is ${title.length} characters (${RANGES.title.join("-")}): "${title}".`,
      )
    }
    if (title) titles.set(title, [...(titles.get(title) ?? []), where])

    const metas = tags(html, "meta")
    const meta = (key, value) =>
      metas.filter((tag) => tag.attrs[key] === value).map((tag) => tag.attrs.content)
    const description = meta("name", "description")
    if (description.length !== 1) errors.push(`${where}: ${description.length} meta descriptions.`)
    else {
      const length = description[0].length
      if (length < RANGES.description[0] || length > RANGES.description[1]) {
        errors.push(
          `${where}: the description is ${length} characters (${RANGES.description.join("-")}).`,
        )
      }
      descriptions.set(description[0], [...(descriptions.get(description[0]) ?? []), where])
    }
    for (const robots of meta("name", "robots")) {
      if (/noindex|none/i.test(robots ?? ""))
        errors.push(
          `${where}: <meta name="robots" content="${robots}"> keeps it out of search engines.`,
        )
    }

    const main = /<main[\s\S]*?<\/main>/.exec(html)?.[0] ?? ""
    const h1 = [...main.matchAll(/<h1[\s>]/g)].length
    if (h1 !== 1) errors.push(`${where}: ${h1} <h1> elements in <main>.`)
    let previous = 1
    for (const heading of main.matchAll(/<h([1-6])[\s>]/g)) {
      const level = Number(heading[1])
      if (level > previous + 1)
        errors.push(`${where}: an <h${level}> follows an <h${previous}> (a level is skipped).`)
      previous = level
    }

    const canonical = tags(html, "link")
      .filter((tag) => tag.attrs.rel === "canonical")
      .map((tag) => tag.attrs.href)
    const expected = `${base}${where}`
    if (canonical.length !== 1) errors.push(`${where}: ${canonical.length} canonical links.`)
    else if (!is404 && canonical[0] !== expected)
      errors.push(`${where}: canonical is ${canonical[0]}, expected ${expected}.`)
    else if (!is404) canonicals.add(canonical[0])

    // Open Graph and Twitter.
    for (const property of ["og:title", "og:description", "og:url", "og:image", "og:type"]) {
      if (meta("property", property).length !== 1) errors.push(`${where}: no single ${property}.`)
    }
    if (meta("name", "twitter:card")[0] !== "summary_large_image")
      errors.push(`${where}: no twitter:card summary_large_image.`)
    const ogUrl = meta("property", "og:url")[0]
    if (!is404 && ogUrl !== expected)
      errors.push(`${where}: og:url is ${ogUrl}, expected ${expected}.`)
    const ogImage = meta("property", "og:image")[0] ?? ""
    if (!ogImage.startsWith(`${base}/`))
      errors.push(`${where}: og:image ${ogImage} is not on ${base}.`)
    else {
      const imageFile = ogImage.slice(base.length + 1)
      if (!view.files.has(imageFile)) errors.push(`${where}: og:image ${imageFile} does not exist.`)
      else {
        const size = pngSize(view.read(imageFile))
        if (size?.width !== 1200 || size.height !== 630)
          errors.push(`${where}: og:image is not a 1200x630 PNG.`)
      }
    }

    // Structured data.
    const blocks = [
      ...html.matchAll(/<script type="?application\/ld\+json"?>([\s\S]*?)<\/script>/g),
    ]
    if (blocks.length !== 1) errors.push(`${where}: ${blocks.length} JSON-LD blocks.`)
    for (const block of blocks) {
      let data
      try {
        data = JSON.parse(block[1])
      } catch (error) {
        errors.push(`${where}: JSON-LD does not parse: ${error.message}`)
        continue
      }
      const graph = data["@graph"] ?? []
      const types = graph.map((node) => node["@type"])
      if (data["@context"] !== "https://schema.org")
        errors.push(`${where}: JSON-LD @context is not https://schema.org.`)
      for (const type of ["WebSite", "Organization"])
        if (!types.includes(type)) errors.push(`${where}: JSON-LD has no ${type}.`)
      if (where === "/" && !types.includes("SoftwareApplication"))
        errors.push("/: JSON-LD has no SoftwareApplication.")
      if (where !== "/" && !is404 && !types.includes("BreadcrumbList"))
        errors.push(`${where}: JSON-LD has no BreadcrumbList.`)
      const article = graph.find((node) => node["@type"] === "TechArticle")
      const h1Text = textOf(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(main)?.[1] ?? "")
      if (article && article.headline !== h1Text)
        errors.push(
          `${where}: TechArticle headline "${article.headline}" differs from the h1 "${h1Text}".`,
        )
      if (article && article.url !== expected)
        errors.push(`${where}: TechArticle url differs from the page.`)
      const crumbs = graph.find((node) => node["@type"] === "BreadcrumbList")
      for (const item of crumbs?.itemListElement ?? []) {
        if (!String(item.item).startsWith(`${base}/`))
          errors.push(`${where}: breadcrumb item ${item.item} is not on ${base}.`)
        else if (!fileFor(view, String(item.item).slice(base.length)))
          errors.push(`${where}: breadcrumb item ${item.item} does not exist.`)
      }
      const serialized = JSON.stringify(data)
      for (const key of FORBIDDEN_LD)
        if (serialized.includes(`"${key}"`))
          errors.push(`${where}: JSON-LD has "${key}" (no ratings, reviews, prices or awards).`)
    }

    // Nothing from other sites; nothing the CSP would block.
    for (const tag of tags(html)) {
      const { name, attrs } = tag
      const loads =
        name === "link" &&
        /^(stylesheet|preload|modulepreload|icon|apple-touch-icon|manifest|prefetch|preconnect|dns-prefetch)$/i.test(
          attrs.rel ?? "",
        )
      const urls = [
        attrs.src,
        attrs.srcset,
        loads ? attrs.href : undefined,
        attrs.poster,
        attrs.data,
      ].filter(Boolean)
      for (const url of urls) {
        if (/^(https?:)?\/\//i.test(url.trim()))
          errors.push(`${where}: <${name}> loads ${url} from another site.`)
      }
      if (["iframe", "object", "embed", "frame"].includes(name))
        errors.push(`${where}: <${name}> is not allowed.`)
      if ("style" in attrs)
        errors.push(`${where}: a style attribute on <${name}> (the CSP allows no inline styles).`)
      if (Object.keys(attrs).some((key) => key.startsWith("on")))
        errors.push(`${where}: an inline event handler on <${name}>.`)
      if (name === "script" && !attrs.src && attrs.type !== "application/ld+json")
        errors.push(`${where}: an inline <script> (the CSP allows none).`)
      if (name === "style")
        errors.push(`${where}: a <style> element (the CSP allows no inline styles).`)
      if (name === "a" && attrs.href) {
        const href = attrs.href
        if (/^(https?:)?\/\//.test(href) && !href.startsWith(`${base}/`)) {
          const rel = (attrs.rel ?? "").split(/\s+/)
          if (!rel.includes("noopener") || !rel.includes("noreferrer"))
            errors.push(`${where}: external link ${href} needs rel="noopener noreferrer".`)
        } else if (href.startsWith("javascript:")) {
          errors.push(`${where}: a javascript: link.`)
        } else if (href.startsWith("/") || href.startsWith("#")) {
          const target = href.startsWith("#") ? file : fileFor(view, href)
          const fragment = href.includes("#") ? href.slice(href.indexOf("#") + 1) : ""
          if (!target) errors.push(`${where}: link to ${href}, which does not exist.`)
          else {
            if (
              fragment &&
              target.endsWith(".html") &&
              !ids.get(target)?.has(decodeURIComponent(fragment))
            ) {
              errors.push(`${where}: link to ${href}: no element with id "${fragment}" there.`)
            }
            if (target !== file && target.endsWith(".html"))
              linkedFrom.set(target, (linkedFrom.get(target) ?? 0) + 1)
          }
        }
      }
      if (name === "img") {
        if (!("alt" in attrs)) errors.push(`${where}: an <img> without alt (${attrs.src}).`)
        if (!attrs.width || !attrs.height)
          errors.push(`${where}: an <img> without width and height (${attrs.src}).`)
      }
      if (name === "source" && (!attrs.width || !attrs.height))
        errors.push(`${where}: a <source> without width and height.`)
    }

    // The published flag: no npm command to run while the packages are not on npm (code blocks;
    // prose may say what will replace the from-source steps).
    const code = [...main.matchAll(/<pre[\s\S]*?<\/pre>/g)]
      .map((block) => textOf(block[0]))
      .join(" ")
    if (params.published === false && NPM_COMMANDS.test(code)) {
      warnings.push(
        `${where}: shows an npm command (${NPM_COMMANDS.exec(code)?.[0]}) while params.published is false.`,
      )
    }
    if (html.includes(REPO_PLACEHOLDER)) placeholderPages.push(where)

    // The framework book does not mention the optional web UI, but for one line.
    if (where.startsWith("/docs/framework/")) {
      const article = /<article[\s\S]*?<\/article>/.exec(html)?.[0] ?? ""
      const articleText = textOf(article)
      const allowed = articleText.split(STUDIO_LINE).length - 1
      studioLines += allowed
      const rest = articleText.split(STUDIO_LINE).join("")
      if (/studio/i.test(rest))
        errors.push(
          `${where}: the framework docs mention "Studio" (only the one line "${STUDIO_LINE}" may).`,
        )
    }
  }

  if (placeholderPages.length > 0) {
    warnings.push(
      `${placeholderPages.length} page(s) link to the placeholder repository URL (set params.repoURL).`,
    )
  }
  if (studioLines !== 1)
    errors.push(
      `The framework docs have ${studioLines} "${STUDIO_LINE}" lines; there must be exactly one.`,
    )
  for (const [title, where] of titles)
    if (where.length > 1) errors.push(`The title "${title}" is used by ${where.join(", ")}.`)
  for (const [description, where] of descriptions)
    if (where.length > 1)
      errors.push(
        `A description is shared by ${where.join(", ")}: "${description.slice(0, 40)}..."`,
      )

  // No orphan: every page but the home page and 404 has a link from another page.
  for (const file of pages) {
    if (file === "index.html" || file === "404.html") continue
    if (!linkedFrom.get(file)) errors.push(`${urlOf(file)}: no other page links to it (an orphan).`)
  }

  // sitemap.xml: exactly the pages, with real dates.
  if (!view.files.has("sitemap.xml")) errors.push("There is no sitemap.xml.")
  else {
    const xml = view.text("sitemap.xml")
    const urls = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((entry) => ({
      loc: /<loc>([^<]+)<\/loc>/.exec(entry[1])?.[1] ?? "",
      lastmod: /<lastmod>([^<]+)<\/lastmod>/.exec(entry[1])?.[1],
    }))
    const locs = new Set(urls.map((url) => url.loc))
    for (const loc of locs) {
      if (!loc.startsWith(`${base}/`) || !fileFor(view, loc.slice(base.length)))
        errors.push(`sitemap.xml lists ${loc}, which does not exist.`)
      else if (!canonicals.has(loc))
        errors.push(`sitemap.xml lists ${loc}, which is not a canonical page URL.`)
    }
    for (const canonical of canonicals)
      if (!locs.has(canonical)) errors.push(`sitemap.xml leaves out ${canonical}.`)
    const now = options.now ?? Date.now()
    for (const url of urls) {
      if (url.lastmod === undefined) continue
      const time = Date.parse(url.lastmod)
      if (Number.isNaN(time) || time > now + DAY || time < Date.parse("2026-01-01"))
        errors.push(`sitemap.xml: ${url.loc} has an implausible lastmod ${url.lastmod}.`)
    }
  }

  // robots.txt: everything allowed, and the sitemap.
  if (!view.files.has("robots.txt")) errors.push("There is no robots.txt.")
  else {
    const robots = view.text("robots.txt")
    if (!/^User-agent: \*$/m.test(robots)) errors.push("robots.txt has no `User-agent: *`.")
    if (/^Disallow:\s*\/\S*/m.test(robots)) errors.push("robots.txt disallows a path.")
    if (!robots.includes(`Sitemap: ${base}/sitemap.xml`))
      errors.push("robots.txt does not name the sitemap.")
  }

  // _headers: noindex only for preview hosts, and the CSP.
  if (!view.files.has("_headers")) errors.push("There is no _headers file.")
  else {
    let pattern = ""
    for (const line of view.text("_headers").split(/\r?\n/)) {
      if (line.trim() === "" || line.trimStart().startsWith("#")) continue
      if (!/^\s/.test(line)) pattern = line.trim()
      else if (
        /x-robots-tag\s*:.*noindex/i.test(line) &&
        !/^https:\/\/(:\w+\.)+pages\.dev\//.test(pattern)
      ) {
        errors.push(
          `_headers: X-Robots-Tag noindex for ${pattern}, which is not a pages.dev preview host.`,
        )
      }
    }
    const headers = view.text("_headers")
    const csp =
      /^\/\*\s*\n(?:\s+.*\n)*?\s+Content-Security-Policy:\s*(.+)$/m.exec(headers)?.[1] ?? ""
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "object-src 'none'",
      "base-uri 'none'",
      "frame-ancestors 'none'",
    ]) {
      if (!csp.includes(directive)) errors.push(`_headers: the CSP for /* lacks ${directive}.`)
    }
    if (/unsafe-inline|unsafe-eval|https?:|\*\s|data:/.test(csp))
      errors.push("_headers: the CSP allows inline code, eval or other origins.")
    for (const header of [
      "X-Content-Type-Options: nosniff",
      "Referrer-Policy:",
      "Permissions-Policy:",
    ]) {
      if (!headers.includes(header)) errors.push(`_headers: no ${header}`)
    }
  }

  // CSS and the performance budget.
  for (const file of view.files) {
    if (file.endsWith(".css")) {
      const css = view.text(file)
      if (/@import|url\(\s*["']?(https?:)?\/\//i.test(css))
        errors.push(`${file}: loads something from another site.`)
      if (view.size(file) > BUDGET.css)
        errors.push(`${file}: ${view.size(file)} bytes, over the CSS budget of ${BUDGET.css}.`)
    }
    if (file.startsWith("screenshots/") && view.size(file) > BUDGET.screenshot)
      errors.push(`${file}: ${view.size(file)} bytes, over the ${BUDGET.screenshot}-byte budget.`)
    if (file.endsWith(".woff2") && view.size(file) > BUDGET.font)
      errors.push(`${file}: ${view.size(file)} bytes, over the font budget.`)
  }
  for (const file of pages) {
    const html = view.text(file)
    const scripts = tags(html, "script")
      .filter((tag) => tag.attrs.src)
      .map((tag) => tag.attrs.src.slice(1))
    const js = scripts.reduce((sum, src) => sum + (view.files.has(src) ? view.size(src) : 0), 0)
    if (js > BUDGET.jsPerPage)
      errors.push(
        `${urlOf(file)}: ${js} bytes of JavaScript, over the ${BUDGET.jsPerPage}-byte budget.`,
      )
  }
  if (view.files.has("index.html")) {
    const html = view.text("index.html")
    const local = (url) => (url?.startsWith("/") ? url.slice(1).split("?")[0] : undefined)
    const stylesheets = tags(html, "link")
      .filter((tag) => tag.attrs.rel === "stylesheet")
      .map((tag) => local(tag.attrs.href))
    const preloads = tags(html, "link")
      .filter((tag) => tag.attrs.rel === "preload")
      .map((tag) => local(tag.attrs.href))
    const scripts = tags(html, "script").map((tag) => local(tag.attrs.src))
    const images = tags(html, "img")
    const lcp = images[0]
    if (!lcp) errors.push("/: no image for the largest contentful paint.")
    else {
      if (lcp.attrs.loading === "lazy")
        errors.push("/: the first image (the LCP candidate) is lazy-loaded.")
      if (lcp.attrs.fetchpriority !== "high")
        errors.push('/: the first image has no fetchpriority="high".')
    }
    // The LCP image: the largest of the first picture's sources.
    const firstPicture = /<picture[\s\S]*?<\/picture>/.exec(html)?.[0] ?? ""
    const lcpFiles = [
      ...tags(firstPicture, "source").map((tag) => local(tag.attrs.srcset)),
      local(lcp?.attrs.src),
    ].filter(Boolean)
    const lcpSize = Math.max(
      0,
      ...lcpFiles.map((name) => (view.files.has(name) ? view.size(name) : 0)),
    )
    if (lcpSize > BUDGET.lcpImage)
      errors.push(`/: the LCP image is ${lcpSize} bytes, over ${BUDGET.lcpImage}.`)
    const sum = (names) =>
      names
        .filter(Boolean)
        .reduce((total, name) => total + (view.files.has(name) ? view.size(name) : 0), 0)
    const initial =
      view.size("index.html") + sum(stylesheets) + sum(preloads) + sum(scripts) + lcpSize
    if (initial > BUDGET.initialLoad)
      errors.push(`/: the initial load is ${initial} bytes, over ${BUDGET.initialLoad}.`)
    // A visitor downloads one variant of each picture (their theme and width): count the largest.
    const pictures = [...html.matchAll(/<picture[\s\S]*?<\/picture>/g)].map((match) => match[0])
    const largest = (block) =>
      Math.max(
        0,
        ...[
          ...tags(block, "source").map((tag) => local(tag.attrs.srcset)),
          ...tags(block, "img").map((tag) => local(tag.attrs.src)),
        ].map((name) => sum([name])),
      )
    const loose = html.replace(/<picture[\s\S]*?<\/picture>/g, "")
    const allImages =
      pictures.reduce((total, block) => total + largest(block), 0) +
      sum(tags(loose, "img").map((tag) => local(tag.attrs.src)))
    if (initial - lcpSize + allImages > BUDGET.homeWithImages)
      errors.push(
        `/: with every image the page is ${initial - lcpSize + allImages} bytes, over ${BUDGET.homeWithImages}.`,
      )
  }

  // The landing page shows the repository's example spec, unchanged.
  if (options.exampleSpec !== undefined && view.files.has("index.html")) {
    const block = /data-example="?landing-spec"?[^>]*>([\s\S]*?)<\/div>/.exec(
      view.text("index.html"),
    )?.[1]
    const shown = block === undefined ? undefined : decodeEntities(block.replace(/<[^>]+>/g, ""))
    const expectedSpec = options.exampleSpec
      .replace(/\r\n/g, "\n")
      .replace(/^# yaml-language-server:[^\n]*\n/, "")
      .trimEnd()
    if (shown === undefined) errors.push("/: the example spec block is missing.")
    else if (shown.trimEnd() !== expectedSpec)
      errors.push("/: the spec shown differs from examples/spec/kervan.yaml.")
  }

  return { errors, warnings }
}

function main() {
  const read = (file) => readFileSync(path.join(root, file), "utf8")
  const strict = process.argv.includes("--strict")
  const dirArg = process.argv.indexOf("--dir")
  const dir =
    dirArg > 0 ? path.resolve(process.argv[dirArg + 1]) : path.join(root, "site", "public")
  const result = checkSecurityTxt(read("site/static/.well-known/security.txt"))
  const errors = [...result.errors]
  const warnings = [...result.warnings]
  if (
    read("site/static/schema/v1.json") !== read("packages/spec-runtime/schema/kervan.schema.json")
  ) {
    errors.push(
      "site/static/schema/v1.json differs from the package's schema: run `pnpm site:schema`.",
    )
  }
  const params = siteParams(read("site/hugo.toml"))
  const config = checkConfig(params)
  errors.push(...config.errors)
  warnings.push(...config.warnings)
  if (existsSync(path.join(dir, "index.html"))) {
    const built = checkBuild(siteView(dir), params, {
      exampleSpec: read("examples/spec/kervan.yaml"),
    })
    errors.push(...built.errors)
    warnings.push(...built.warnings)
  } else {
    warnings.push(
      `No built site in ${path.relative(root, dir)}: run \`pnpm site:build\` to check the pages too.`,
    )
  }
  for (const warning of warnings) console.warn(`warning: ${warning}`)
  for (const error of errors) console.error(`error: ${error}`)
  if (exitCode({ errors, warnings }, strict) !== 0) process.exit(1)
  console.log(warnings.length > 0 ? "check:site passed with warnings." : "check:site passed.")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
