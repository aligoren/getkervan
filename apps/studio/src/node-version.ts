// The Node.js versions Studio runs on: `engines` in its package.json, which the repository keeps
// equal for every runtime package (a repository test): the oldest release of each line the whole
// test suite has passed on. Older ones are refused at start, not merely warned about: below 22.13
// the select process's sandbox needs a different permission flag that was never tested, and
// Studio's security rests on it (docs/THREAT-MODEL-STUDIO.md, T19); Node 24 before 24.21 can crash
// on Windows (a libuv bug).
import { readFileSync } from "node:fs"

/** `engines.node` of Studio's package.json, e.g. `^22.23.3 || >=24.21.0`. */
export const NODE_ENGINES: string = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    engines: { node: string }
  }
).engines.node

type Triple = [number, number, number]

function parse(version: string): Triple | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

function atLeast(version: Triple, floor: Triple): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== floor[i]) return (version[i] ?? 0) > (floor[i] ?? 0)
  }
  return true
}

/** The parts of the range: `^x.y.z` (that line, from x.y.z) or `>=x.y.z` (from x.y.z on). */
function floors(engines: string): { line: boolean; floor: Triple }[] {
  return engines.split("||").map((part) => {
    const match = /^\s*(\^|>=)(\d+\.\d+\.\d+)\s*$/.exec(part)
    const floor = match && parse(match[2] as string)
    if (!floor) throw new Error(`Unsupported engines range "${engines}"`)
    return { line: match[1] === "^", floor }
  })
}

/** "22.23.3 or a later 22.x, or 24.21.0 or later". */
export function describeEngines(engines = NODE_ENGINES): string {
  return floors(engines)
    .map(({ line, floor }) =>
      line ? `${floor.join(".")} or a later ${floor[0]}.x` : `${floor.join(".")} or later`,
    )
    .join(", or ")
}

/** Why Studio does not run on this Node.js version, or `undefined` when it does. */
export function nodeVersionProblem(version: string, engines = NODE_ENGINES): string | undefined {
  const parsed = parse(version)
  const supported =
    parsed !== undefined &&
    floors(engines).some(
      ({ line, floor }) => atLeast(parsed, floor) && (!line || parsed[0] === floor[0]),
    )
  if (supported) return undefined
  return (
    `Kervan Studio needs Node.js ${describeEngines(engines)}; this is ${version}. ` +
    "Older versions were not tested: the sandbox of spec select expressions depends on Node's " +
    "permission model, and Node 24 before 24.21 can crash on Windows. Upgrade Node.js."
  )
}
