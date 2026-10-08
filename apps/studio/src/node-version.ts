// The Node.js versions Studio runs on: the oldest release of each line its whole test suite has
// run on. Older ones are refused at start, not merely warned about: below 22.13 the select
// process's sandbox needs a different permission flag that was never tested, and Studio's
// security rests on it (docs/THREAT-MODEL-STUDIO.md, T19). Keep `engines` in package.json equal.

/** The oldest tested release of each supported line; a newer line counts from its first release. */
export const SUPPORTED_NODE = [
  [22, 23, 3],
  [24, 15, 0],
] as const

/** `engines.node` of Studio's package.json, from `SUPPORTED_NODE` (a test keeps them equal). */
export const NODE_ENGINES = SUPPORTED_NODE.map(([major, minor, patch], index) =>
  index === SUPPORTED_NODE.length - 1
    ? `>=${major}.${minor}.${patch}`
    : `^${major}.${minor}.${patch}`,
).join(" || ")

function parse(version: string): [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

function atLeast(version: readonly number[], floor: readonly number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((version[i] ?? 0) !== (floor[i] ?? 0)) return (version[i] ?? 0) > (floor[i] ?? 0)
  }
  return true
}

/** Why Studio does not run on this Node.js version, or `undefined` when it does. */
export function nodeVersionProblem(version: string): string | undefined {
  const parsed = parse(version)
  const newest = SUPPORTED_NODE[SUPPORTED_NODE.length - 1]
  const supported =
    parsed !== undefined &&
    (SUPPORTED_NODE.some((floor) => parsed[0] === floor[0] && atLeast(parsed, floor)) ||
      (newest !== undefined && parsed[0] > newest[0]))
  if (supported) return undefined
  const wanted = SUPPORTED_NODE.map((floor, index) =>
    index === SUPPORTED_NODE.length - 1
      ? `${floor.join(".")} or later`
      : `${floor.join(".")} or a later ${floor[0]}.x`,
  ).join(", or ")
  return (
    `Kervan Studio needs Node.js ${wanted}; this is ${version}. ` +
    "Older versions were not tested, and the sandbox of spec select expressions depends on " +
    "Node's permission model. Upgrade Node.js."
  )
}
