import { readFileSync } from "node:fs"

/**
 * The Node.js releases Kervan's tools run on, from this package's `engines` (the repository keeps
 * every runtime package and the generated project on the same range: the oldest release of each
 * line the whole test suite has passed on). They all run TypeScript without flags.
 */
export const NODE_ENGINES: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    engines: { node: string }
  }
).engines.node

interface Version {
  major: number
  minor: number
  patch: number
}

export function parseVersion(version: string): Version {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match) throw new Error(`Unrecognized Node.js version "${version}"`)
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

const compare = (a: Version, b: Version) =>
  a.major - b.major || a.minor - b.minor || a.patch - b.patch

/**
 * Whether a version is in an engines range made of `^x.y.z` (that line, from x.y.z) and
 * `>=x.y.z` (from x.y.z on) parts joined by `||`.
 */
export function satisfiesEngines(version: string, engines = NODE_ENGINES): boolean {
  const current = parseVersion(version)
  return engines.split("||").some((part) => {
    const match = /^\s*(\^|>=)(\d+\.\d+\.\d+)\s*$/.exec(part)
    if (!match) throw new Error(`Unsupported engines range "${engines}"`)
    const floor = parseVersion(match[2] as string)
    if (compare(current, floor) < 0) return false
    return match[1] === ">=" || current.major === floor.major
  })
}

/** "22.23.3 or a later 22.x, or 24.21.0 or later", from the engines range. */
export function describeEngines(engines = NODE_ENGINES): string {
  return engines
    .split("||")
    .map((part) => part.trim())
    .map((part) =>
      part.startsWith("^")
        ? `${part.slice(1)} or a later ${part.slice(1).split(".")[0]}.x`
        : `${part.slice(2)} or later`,
    )
    .join(", or ")
}

export interface RuntimeInfo {
  version: string
  platform: NodeJS.Platform
  /** `process.features.typescript`: false when disabled, e.g. with --no-experimental-strip-types. */
  typescript: string | false | undefined
}

export function currentRuntime(): RuntimeInfo {
  const features = process.features as { typescript?: string | false }
  return { version: process.version, platform: process.platform, typescript: features.typescript }
}

/** Why Kervan's tools do not run on this Node.js version, or undefined. */
export function nodeVersionProblem(runtime: RuntimeInfo = currentRuntime()): string | undefined {
  if (satisfiesEngines(runtime.version)) return undefined
  return (
    `Kervan needs Node.js ${describeEngines()}; you are running ${runtime.version}. ` +
    "Older releases were not tested (and Node 24 before 24.21 can crash on Windows). " +
    "Please upgrade Node.js."
  )
}

/** Returns an error message when this runtime cannot run a Kervan TypeScript project directly. */
export function typeStrippingProblem(runtime: RuntimeInfo = currentRuntime()): string | undefined {
  const version = nodeVersionProblem(runtime)
  if (version) return version
  if (runtime.typescript === false) {
    return (
      "Node.js type stripping is disabled in this process (for example by " +
      "--no-experimental-strip-types in NODE_OPTIONS). Kervan projects need it enabled."
    )
  }
  return undefined
}
