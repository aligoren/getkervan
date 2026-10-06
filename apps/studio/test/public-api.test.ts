import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const src = fileURLToPath(new URL("../src", import.meta.url))
const webSrc = fileURLToPath(new URL("../web/src", import.meta.url))

/** The framework entry points Studio may use: the packages' public API (docs/API.md). */
const PUBLIC_ENTRY_POINTS = new Set([
  "@kervan/core",
  "@kervan/transport",
  "@kervan/transport/node",
  "@kervan/spec-runtime",
  // The editor schema, a published file of the package.
  "@kervan/spec-runtime/schema/kervan.schema.json",
])

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : []
  })
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8")
  const specifiers = [
    ...text.matchAll(/\bfrom\s+"([^"]+)"/g),
    ...text.matchAll(/\bimport\s*\(\s*"([^"]+)"\s*\)/g),
    ...text.matchAll(/^\s*import\s+"([^"]+)"/gm),
  ]
  return specifiers.map((match) => match[1] ?? "")
}

describe("Studio uses only the framework's public API", () => {
  const files = [...sourceFiles(src), ...sourceFiles(webSrc)]

  it("finds the sources", () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it("imports @kervan/* only through public entry points", () => {
    const offending = files.flatMap((file) =>
      importsOf(file)
        .filter((spec) => spec.startsWith("@kervan/") && !PUBLIC_ENTRY_POINTS.has(spec))
        .map((spec) => `${path.relative(src, file)}: ${spec}`),
    )
    expect(offending).toEqual([])
  })

  it("never reaches into framework sources by path", () => {
    const offending = files.flatMap((file) =>
      importsOf(file)
        .filter((spec) => {
          if (!spec.startsWith(".")) return false
          const target = path.resolve(path.dirname(file), spec)
          return !target.startsWith(src) && !target.startsWith(webSrc)
        })
        .map((spec) => `${path.relative(src, file)}: ${spec}`),
    )
    expect(offending).toEqual([])
  })

  it("never allows private network addresses for spec tools", () => {
    // The SSRF policy is built in network.ts without this field; no code may set it.
    const offending = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .map((line, i) => [line, i + 1] as const)
        .filter(([line]) => /allowPrivate/.test(line) && !/^\s*(\/\/|\*|\/\*\*)/.test(line))
        .map(([line, n]) => `${path.relative(src, file)}:${n}: ${line.trim()}`),
    )
    expect(offending).toEqual([])
  })
})
