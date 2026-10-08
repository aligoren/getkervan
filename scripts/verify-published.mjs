// `pnpm verify:published [--tag next] [--version 0.1.0-rc.1]`: after a release, checks what the
// npm registry serves for the five packages. A release tool, not part of Kervan.
//
// 1. `npm view <name>@<version>`: the version exists, the dist-tag points at it, and `license`,
//    `engines` and `repository` are what the repository's package.json files say.
// 2. Downloads each tarball (`npm pack <name>@<version>`) into a temporary folder outside the
//    repository, checks its sha512 against the registry's `dist.integrity`, and its files against
//    the same allow list as `pnpm test:pack`.
// 3. In a fresh temporary project, installs the packages by the dist-tag (`<name>@next`), checks
//    that the tag installs this version, and runs the smoke tests of `pnpm test:pack`: `kervan
//    --help`, `kervan run` on the example spec answering tools/list, and a project made by
//    `create-kervan` installing from the registry and passing its tests.
//
// With `--tarballs <dir>` (the folder of RELEASING.md's step 4), each registry `dist.integrity`
// must also be the sha512 of the tarball that was published from there.
//
// It reads from the public registry (named on every npm command) and writes to its temporary
// folder and npm's own cache and logs: it publishes nothing, changes no dist-tag and touches no
// file in the repository.
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  commandFile,
  contentProblems,
  listToolsOverHttp,
  PACKAGES,
  readTarball,
  run,
} from "./pack-check.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

/** npm dist-tags as Kervan uses them; anything else is refused before it reaches a command. */
const TAG = /^[a-z][a-z0-9-]{0,31}$/
/** A semantic version, with an optional pre-release part. */
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

/** The public registry, named on every npm command: a configured one (a local Verdaccio) is not it. */
export const REGISTRY = "https://registry.npmjs.org/"

/**
 * `--tag <tag>` (default `next`), `--version <version>` (default: the repository's) and
 * `--tarballs <dir>`: the folder of the tarballs that were published (RELEASING.md, step 4).
 */
export function parseArgs(argv, defaultVersion) {
  const options = { tag: "next", version: defaultVersion, tarballs: undefined }
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = [argv[i], argv[i + 1]]
    if (!["--tag", "--version", "--tarballs"].includes(flag))
      throw new Error(`Unknown argument: ${flag}`)
    if (value === undefined) throw new Error(`${flag} needs a value.`)
    if (flag === "--tag") options.tag = value
    else if (flag === "--version") options.version = value
    else options.tarballs = path.resolve(value)
    i++
  }
  if (!TAG.test(options.tag)) throw new Error(`Not a dist-tag: ${JSON.stringify(options.tag)}`)
  if (!VERSION.test(options.version ?? ""))
    throw new Error(`Not a version: ${JSON.stringify(options.version)}`)
  return options
}

/** What the registry should say about each package: from the repository's package.json files. */
export function expectedManifests(version, readManifest) {
  return PACKAGES.map((pkg) => {
    const manifest = readManifest(pkg.dir)
    return {
      name: pkg.name,
      version,
      license: manifest.license,
      engines: manifest.engines?.node,
      repository: manifest.repository,
    }
  })
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Problems with what `npm view <name>@<version> --json` returned (`viewed`, or undefined when the
 * registry has no such version) against `expected`, for the dist-tag `tag`.
 */
export function viewProblems(expected, viewed, tag) {
  const { name, version } = expected
  if (!viewed || typeof viewed !== "object") return [`${name}@${version} is not on the registry.`]
  const problems = []
  if (viewed.name !== name) problems.push(`${name}: the registry answered for ${viewed.name}.`)
  if (viewed.version !== version)
    problems.push(`${name}: version ${viewed.version}, expected ${version}.`)
  const tagged = viewed["dist-tags"]?.[tag]
  if (tagged !== version)
    problems.push(`${name}: dist-tag ${tag} is ${tagged ?? "not set"}, expected ${version}.`)
  if (viewed.license !== expected.license)
    problems.push(`${name}: license ${viewed.license}, expected ${expected.license}.`)
  if (viewed.engines?.node !== expected.engines)
    problems.push(`${name}: engines.node ${viewed.engines?.node}, expected ${expected.engines}.`)
  if (!same(viewed.repository, expected.repository))
    problems.push(
      `${name}: repository ${JSON.stringify(viewed.repository)}, expected ${JSON.stringify(expected.repository)}.`,
    )
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(viewed.dist?.integrity ?? ""))
    problems.push(`${name}: no sha512 integrity in dist (${viewed.dist?.integrity}).`)
  return problems
}

/** The file `pnpm pack` writes for a package: `@kervan/core` 1.0.0 is `kervan-core-1.0.0.tgz`. */
export function tarballName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`
}

/**
 * Problems with a tarball's bytes against the registry's `dist.integrity`. For the tarballs that
 * were published (`--tarballs`) this is the check that matters: the registry serves exactly the
 * bytes that were built and checked. (npm itself checks a download against the same registry's
 * integrity, which says nothing about where the bytes came from.)
 */
export function integrityProblems(name, bytes, integrity) {
  const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`
  return actual === integrity ? [] : [`${name}: the tarball's sha512 is not dist.integrity.`]
}

/** `npm view <spec> --json`, or undefined when the registry has no such package or version. */
function view(spec, cwd) {
  try {
    return JSON.parse(run("npm", ["view", spec, "--json", "--registry", REGISTRY], { cwd }))
  } catch (error) {
    if (/E404/.test(String(error.message))) return undefined
    throw error
  }
}

async function main() {
  const repoVersion = JSON.parse(
    readFileSync(path.join(root, PACKAGES[0].dir, "package.json"), "utf8"),
  ).version
  const { tag, version, tarballs: published } = parseArgs(process.argv.slice(2), repoVersion)
  if (published === undefined)
    console.warn(
      "warning: without --tarballs, nothing shows that the registry serves the tarballs that were built and checked.",
    )
  const expected = expectedManifests(version, (dir) =>
    JSON.parse(readFileSync(path.join(root, dir, "package.json"), "utf8")),
  )
  const work = mkdtempSync(path.join(os.tmpdir(), "kervan-verify-"))
  const failures = []
  try {
    // 1-2. The registry's view of each package, and its tarball.
    const tarballs = path.join(work, "tarballs")
    mkdirSync(tarballs)
    for (const [index, pkg] of PACKAGES.entries()) {
      const want = expected[index]
      const viewed = view(`${pkg.name}@${version}`, work)
      const problems = viewProblems(want, viewed, tag)
      if (viewed) {
        const before = new Set(readdirSync(tarballs))
        run(
          "npm",
          [
            "pack",
            `${pkg.name}@${version}`,
            "--pack-destination",
            tarballs,
            "--registry",
            REGISTRY,
          ],
          {
            cwd: work,
          },
        )
        const file = readdirSync(tarballs).find((name) => !before.has(name))
        if (!file) problems.push(`${pkg.name}: npm pack downloaded nothing.`)
        else {
          const bytes = readFileSync(path.join(tarballs, file))
          problems.push(...integrityProblems(pkg.name, bytes, viewed.dist?.integrity))
          if (published !== undefined) {
            const local = path.join(published, tarballName(pkg.name, version))
            if (!existsSync(local)) problems.push(`${pkg.name}: ${local} is missing.`)
            else
              problems.push(
                ...integrityProblems(
                  `${pkg.name} (the published tarball, ${path.basename(local)})`,
                  readFileSync(local),
                  viewed.dist?.integrity,
                ),
              )
          }
          const packed = readTarball(path.join(tarballs, file))
          problems.push(...contentProblems(pkg, packed.files, packed.size))
        }
      }
      failures.push(...problems)
      console.log(`${problems.length ? "FAIL" : "ok  "} ${pkg.name}@${version} (${tag})`)
    }
    if (failures.length > 0) throw new Error(failures.join("\n"))

    // 3. Installed by the dist-tag, as users will, in a project outside the repository.
    const app = path.join(work, "app")
    mkdirSync(app)
    writeFileSync(
      path.join(app, "package.json"),
      JSON.stringify({ name: "verify-published", private: true, type: "module" }),
    )
    run(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--registry",
        REGISTRY,
        ...PACKAGES.map((p) => `${p.name}@${tag}`),
      ],
      {
        cwd: app,
      },
    )
    for (const pkg of PACKAGES) {
      const installed = JSON.parse(
        readFileSync(
          path.join(app, "node_modules", ...pkg.name.split("/"), "package.json"),
          "utf8",
        ),
      ).version
      if (installed !== version)
        failures.push(`${pkg.name}@${tag} installed ${installed}, expected ${version}.`)
    }
    const bin = commandFile(app, "kervan", "kervan")
    if (!run(process.execPath, [bin, "--help"], { cwd: app }).startsWith("Usage: kervan <command>"))
      failures.push("kervan --help does not print the usage.")
    else console.log("ok   kervan --help")
    const spec = path.join(app, "kervan.yaml")
    writeFileSync(spec, readFileSync(path.join(root, "examples", "spec", "kervan.yaml")))
    const tools = await listToolsOverHttp(app, spec)
    if (tools.join(",") !== "search_city,get_current_weather")
      failures.push(`kervan run on the example spec listed: ${tools.join(", ") || "nothing"}`)
    else console.log(`ok   kervan run: tools/list = ${tools.join(", ")}`)

    run(
      process.execPath,
      [commandFile(app, "create-kervan", "create-kervan"), "made", "--no-install"],
      { cwd: work },
    )
    const made = path.join(work, "made")
    const deps = JSON.parse(readFileSync(path.join(made, "package.json"), "utf8")).dependencies
    for (const [name, range] of Object.entries(deps ?? {})) {
      if (name.startsWith("@kervan/") && range !== `^${version}`)
        failures.push(`create-kervan wrote ${name}@${range}, expected ^${version}.`)
    }
    run("npm", ["install", "--no-audit", "--no-fund", "--registry", REGISTRY], { cwd: made })
    run("npm", ["test"], { cwd: made })
    console.log("ok   create-kervan: a new project installs from the registry and its tests pass")
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5 })
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`error: ${failure}`)
    process.exit(1)
  }
  console.log(`verify:published passed: ${version} under ${tag}.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exit(1)
  })
}
