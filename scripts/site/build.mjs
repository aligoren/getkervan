// `pnpm site:build`: builds the website with Hugo into site/public (or --destination <dir>).
// The Hugo version is pinned in one place, site/.hugo-version; this refuses any other version with
// one line saying how to install the right one. Standard Hugo is enough (no Sass, no extended
// features); the extended edition of the same version works too. No dependencies: Cloudflare
// Pages runs this with its own Node.js (see docs/SITE.md).
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")

export function pinnedHugoVersion() {
  const version = readFileSync(path.join(root, "site", ".hugo-version"), "utf8").trim()
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error(`site/.hugo-version is not a version: ${version}`)
  return version
}

/** The version in `hugo version` output ("hugo v0.167.0-...+extended ..."), or undefined. */
export function parseHugoVersion(output) {
  return /\bhugo v(\d+\.\d+\.\d+)\b/.exec(output)?.[1]
}

export function installHint(version) {
  return (
    `Install Hugo ${version} (standard or extended). Windows: winget install Hugo.Hugo --version ${version} ` +
    `(or: scoop install hugo@${version}, choco install hugo --version ${version}). Linux: ` +
    `scripts/site/install-hugo.sh (downloads the release and checks its SHA-256). See docs/SITE.md.`
  )
}

/** Why the installed Hugo cannot build the site, or undefined. */
export function hugoProblem(versionOutput, pinned) {
  const found = parseHugoVersion(versionOutput ?? "")
  if (!found) return `Hugo was not found. ${installHint(pinned)}`
  if (found !== pinned)
    return `Hugo ${found} is installed, the site needs ${pinned}. ${installHint(pinned)}`
  return undefined
}

function main() {
  const pinned = pinnedHugoVersion()
  const probe = spawnSync("hugo", ["version"], { encoding: "utf8" })
  const problem = hugoProblem(probe.error ? undefined : probe.stdout, pinned)
  if (problem) {
    console.error(`Error: ${problem}`)
    process.exit(1)
  }
  const extra = process.argv.slice(2)
  const result = spawnSync(
    "hugo",
    [
      "--source",
      path.join(root, "site"),
      "--minify",
      "--cleanDestinationDir",
      "--panicOnWarning",
      ...extra,
    ],
    { stdio: "inherit" },
  )
  process.exit(result.status ?? 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
