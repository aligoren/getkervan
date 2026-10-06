/** First releases that run `.ts` files without flags: 22.18.0 (LTS line) and 23.6.0. */
export const TYPE_STRIPPING_ENGINES = "^22.18.0 || >=23.6.0"

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

/** Whether this Node.js version strips TypeScript types without flags. */
export function supportsTypeStripping(version: string): boolean {
  const { major, minor } = parseVersion(version)
  if (major === 22) return minor >= 18
  if (major === 23) return minor >= 6
  return major >= 24
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

/** Returns an error message when this runtime cannot run a Kervan TypeScript project directly. */
export function typeStrippingProblem(runtime: RuntimeInfo = currentRuntime()): string | undefined {
  if (!supportsTypeStripping(runtime.version)) {
    return (
      `Kervan projects run TypeScript with Node.js's built-in type stripping, which needs ` +
      `Node.js 22.18.0+ (or 23.6.0+). You are running ${runtime.version}. Please upgrade Node.js.`
    )
  }
  if (runtime.typescript === false) {
    return (
      "Node.js type stripping is disabled in this process (for example by " +
      "--no-experimental-strip-types in NODE_OPTIONS). Kervan projects need it enabled."
    )
  }
  return undefined
}

/**
 * Node 24 before 24.21 on Windows ships libuv 1.51, which can crash with a
 * `UV_HANDLE_CLOSING` assertion around fetch and process exit.
 */
export function windowsLibuvWarning(runtime: RuntimeInfo = currentRuntime()): string | undefined {
  if (runtime.platform !== "win32") return undefined
  const { major, minor } = parseVersion(runtime.version)
  if (major !== 24 || minor >= 21) return undefined
  return (
    `Node.js ${runtime.version} on Windows has a libuv bug that can crash processes with ` +
    `"Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)". Upgrade to Node.js 24.21 or newer.`
  )
}
