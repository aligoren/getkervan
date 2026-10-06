import { existsSync, watch } from "node:fs"
import path from "node:path"

const IGNORED_DIRS = new Set(["node_modules", "dist", ".git", "coverage", ".turbo", ".cache"])
const WATCHED_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".json"])

/**
 * Whether a change to `file` (relative to the watched root, with either separator) should reload
 * the server. `null` means the platform did not say which file changed.
 */
export function shouldReload(file: string | null): boolean {
  if (file === null) return true
  const segments = file.split(/[\\/]+/).filter(Boolean)
  if (segments.some((segment) => IGNORED_DIRS.has(segment))) return false
  const name = segments.at(-1) ?? ""
  return WATCHED_EXTENSIONS.has(path.extname(name).toLowerCase())
}

/** Nearest directory at or above `dir` that has a package.json; `dir` itself if none does. */
export function findProjectRoot(dir: string): string {
  let current = path.resolve(dir)
  for (;;) {
    if (existsSync(path.join(current, "package.json"))) return current
    const parent = path.dirname(current)
    if (parent === current) return path.resolve(dir)
    current = parent
  }
}

/** Calls `onChange` (debounced) when source files under `root` change. Returns a stop function. */
export function watchProject(
  root: string,
  onChange: (files: string[]) => void,
  debounceMs = 100,
): () => void {
  let timer: NodeJS.Timeout | undefined
  const changed = new Set<string>()
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    const file = filename === null ? null : filename.toString()
    if (!shouldReload(file)) return
    changed.add(file ?? "?")
    clearTimeout(timer)
    timer = setTimeout(() => {
      const files = [...changed]
      changed.clear()
      onChange(files)
    }, debounceMs)
  })
  return () => {
    clearTimeout(timer)
    watcher.close()
  }
}
