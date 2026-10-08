// A static server for the built site, close to Cloudflare Pages for what the checks need: the
// `_headers` rules (so the browser enforces the real CSP), `/dir/` -> `/dir/index.html`, and the
// 404 page with status 404. Paths are resolved inside the site folder only.
// `node scripts/site/serve.mjs [dir] [port]` serves site/public on http://127.0.0.1:4320.
import { readFileSync, statSync } from "node:fs"
import { createServer } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
}

/** `_headers` rules: [{ pattern, headers }], in file order (Cloudflare applies every match). */
export function parseHeaders(text) {
  const rules = []
  let current
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === "" || raw.trimStart().startsWith("#")) continue
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: [] }
      rules.push(current)
    } else if (current) {
      const at = raw.indexOf(":")
      current.headers.push([raw.slice(0, at).trim(), raw.slice(at + 1).trim()])
    }
  }
  return rules
}

/** Whether a rule's pattern (a path with `*` and `:name`, or an absolute https URL) matches. */
export function ruleMatches(pattern, host, pathname) {
  let target = pathname
  let source = pattern
  if (/^https:\/\//.test(pattern)) {
    const url = new URL(pattern.replace(/:([A-Za-z]\w*)/g, "PLACEHOLDER-$1").replace("*", "SPLAT"))
    source = `${url.hostname}${url.pathname}`
      .replace(/PLACEHOLDER-\w+/g, ":p")
      .replace("SPLAT", "*")
    target = `${host}${pathname}`
  }
  const regex = new RegExp(
    `^${source
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/:[A-Za-z]\w*/g, "[^./]+"))
      .join(".*")}$`,
  )
  return regex.test(target)
}

export function startStatic(dir, port = 4320, host = "127.0.0.1") {
  const root = path.resolve(dir)
  const rules = (() => {
    try {
      return parseHeaders(readFileSync(path.join(root, "_headers"), "utf8"))
    } catch {
      return []
    }
  })()
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost")
    let pathname
    try {
      pathname = decodeURIComponent(url.pathname)
    } catch {
      response.writeHead(400).end()
      return
    }
    if (pathname.includes("\0")) {
      response.writeHead(400).end()
      return
    }
    if (pathname.endsWith("/")) pathname += "index.html"
    let file = path.resolve(root, `.${pathname}`)
    if (!file.startsWith(root + path.sep)) {
      response.writeHead(400).end()
      return
    }
    let status = 200
    try {
      if (statSync(file).isDirectory()) {
        response.writeHead(301, { location: `${url.pathname}/` }).end()
        return
      }
    } catch {
      file = path.join(root, "404.html")
      status = 404
    }
    const headers = { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" }
    const hostname = (request.headers.host ?? "").split(":")[0]
    for (const rule of rules) {
      if (ruleMatches(rule.pattern, hostname, url.pathname)) {
        for (const [name, value] of rule.headers) headers[name.toLowerCase()] = value
      }
    }
    response.writeHead(status, headers)
    response.end(readFileSync(file))
  })
  return new Promise((resolve) =>
    server.listen(port, host, () =>
      resolve({
        url: `http://${host}:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      }),
    ),
  )
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
  const { url } = await startStatic(
    process.argv[2] ?? path.join(root, "site", "public"),
    Number(process.argv[3] ?? 4320),
  )
  console.log(`Serving the site on ${url}`)
}
