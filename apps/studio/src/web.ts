import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { Context } from "hono"

/** Where `vite build` puts the web UI: `apps/studio/dist-web`. */
export const WEB_ROOT = fileURLToPath(new URL("../dist-web", import.meta.url))

/**
 * The Content-Security-Policy of the web UI. Scripts, workers and connections are same-origin
 * only; nothing can be framed, no plugins, no `<base>` rewriting, forms post only to Studio.
 * Inline styles are allowed because the Monaco editor sets them; inline scripts are not.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ")

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
}

/**
 * Serves the built web UI. Paths are resolved inside `root` only (no `..`, no encoded tricks);
 * unknown paths without an extension get `index.html`, so client-side routes work.
 */
export function serveWeb(root = WEB_ROOT) {
  const base = path.resolve(root)
  return async (c: Context): Promise<Response> => {
    const file = await locate(base, c.req.path)
    if (file === "missing") {
      return c.text("The Kervan Studio web UI is not built. Run `pnpm build`.", 503)
    }
    if (!file) return c.text("Not found", 404)
    const type = TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream"
    const hashed = file.startsWith(path.join(base, "assets") + path.sep)
    return c.body(await readFile(file), 200, {
      "content-type": type,
      "content-security-policy": APP_CSP,
      "cache-control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    })
  }
}

async function locate(base: string, urlPath: string): Promise<string | "missing" | undefined> {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return undefined
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined
  if (decoded.split("/").some((segment) => segment === "..")) return undefined
  const candidate = path.resolve(base, `.${decoded}`)
  if (!isInside(base, candidate)) return undefined
  if (await isFile(candidate)) return candidate
  if (path.extname(decoded) !== "") return undefined
  const index = path.join(base, "index.html")
  return (await isFile(index)) ? index : "missing"
}

/** Whether `candidate` is `base` or inside it (not merely sharing a prefix, like `/web2`). */
export function isInside(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(base + path.sep)
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile()
  } catch {
    return false
  }
}
