// `pnpm test:pack`: what the npm packages would contain, checked before anything is published.
//
// 1. Packs every published package with `pnpm pack` (which writes real versions in place of
//    `workspace:` dependencies) into a temporary folder outside the repository.
// 2. Checks each tarball against its allow list (and a deny list of things that must never ship:
//    environment files, databases, keys, tests, sources, source maps, local tool files,
//    screenshots), a size budget, and that its package.json has no `workspace:` version.
// 3. Installs all tarballs with npm into a fresh folder outside the repository (real copies, no
//    workspace links) and runs smoke tests: `kervan --help`, `kervan run --help`, importing
//    `createApp` and `createTestClient` and calling a tool, `kervan run` on the example spec over
//    HTTP answering tools/list, and `create-kervan` making a project whose tests pass.
//
// Nothing is published. The npm install fetches third-party dependencies from the registry (or
// npm's cache); no smoke test calls an external API.
import { spawn, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { gunzipSync } from "node:zlib"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const isWindows = process.platform === "win32"

/** Each published package: its folder, what its tarball may hold, and its size budget (bytes). */
export const PACKAGES = [
  {
    dir: "packages/core",
    name: "@kervan/core",
    allow: [/^dist\/.+\.(js|d\.ts)$/],
    budget: 120_000,
  },
  {
    dir: "packages/transport",
    name: "@kervan/transport",
    allow: [/^dist\/.+\.(js|d\.ts)$/],
    budget: 80_000,
  },
  {
    dir: "packages/spec-runtime",
    name: "@kervan/spec-runtime",
    allow: [/^dist\/.+\.(js|d\.ts)$/, /^schema\/kervan\.schema\.json$/],
    budget: 300_000,
  },
  {
    dir: "packages/cli",
    name: "kervan",
    allow: [/^dist\/.+\.(js|d\.ts)$/, /^bin\/[\w-]+\.js$/, /^templates\/basic\/.+/],
    budget: 220_000,
  },
  {
    dir: "packages/create-kervan",
    name: "create-kervan",
    allow: [/^bin\/[\w-]+\.js$/],
    budget: 10_000,
  },
]

/** In every package: the manifest, the README and the license. */
const ALWAYS = [/^package\.json$/, /^README\.md$/, /^LICENSE$/]

/**
 * Never in a package, whatever its allow list says. The third field, when true, exempts the
 * project template (templates/basic/): a new project needs its own sources and test.
 */
const DENY = [
  [/(^|\/)\.env(\.|$)/, "an environment file"],
  [/\.(sqlite3?|db)(-wal|-shm|-journal)?$/, "a database file"],
  [/\.(pem|key|p12|pfx)$/, "a key or certificate"],
  [/(^|\/)(test|tests|__tests__|e2e)\//, "a test", true],
  [/\.(test|spec)\.[cm]?[jt]sx?$/, "a test", true],
  [/(^|\/)src\//, "a source file", true],
  [/\.map$/, "a source map"],
  [/\.tsbuildinfo$/, "a TypeScript build file"],
  [/(^|\/)(CLAUDE(\.local)?\.md|\.claude\/|\.mcp\.json)/, "a local tool file"],
  [/(^|\/)(scratch|tmp|temp|screenshots?)\//, "a scratch or screenshot folder"],
  [/\.(png|jpe?g|webp|gif)$/, "an image"],
]

/** Problems with one tarball's file list (paths inside "package/") and its total size. */
export function contentProblems(pkg, files, size) {
  const problems = []
  for (const file of files) {
    const template = file.startsWith("templates/basic/")
    const denied = DENY.find(
      ([pattern, , templateMay]) => pattern.test(file) && !(template && templateMay),
    )
    if (denied) problems.push(`${pkg.name}: ${file} is ${denied[1]}; it must not be published.`)
    else if (![...ALWAYS, ...pkg.allow].some((pattern) => pattern.test(file)))
      problems.push(`${pkg.name}: ${file} is not on the package's allow list.`)
  }
  for (const required of ["package.json", "README.md", "LICENSE"]) {
    if (!files.includes(required)) problems.push(`${pkg.name}: ${required} is missing.`)
  }
  if (size > pkg.budget)
    problems.push(`${pkg.name}: ${size} bytes unpacked, over the ${pkg.budget}-byte budget.`)
  return problems
}

/**
 * Problems with the source maps the tarball's scripts name (`//# sourceMappingURL=`): a map that
 * is not in the package makes bundlers warn about every file.
 */
export function sourceMapProblems(pkg, files, mapRefs) {
  return mapRefs
    .filter(({ map }) => !files.includes(map))
    .map(({ file, map }) => `${pkg.name}: ${file} refers to ${map}, which is not in the package.`)
}

/**
 * Problems with build output whose source is gone: `tsc -b` never deletes old files from `dist`,
 * so a module deleted or renamed in `src` would still ship from an old checkout.
 * `hasSource(path)` says whether a file exists in the package folder.
 */
export function orphanProblems(pkg, files, hasSource) {
  return files
    .map((file) => ({ file, stem: /^dist\/(.+?)(?:\.d\.ts|\.js)$/.exec(file)?.[1] }))
    .filter(({ stem }) => stem)
    .map(({ file, stem }) => ({ file, base: `src/${stem}` }))
    .filter(({ base }) => ![".ts", ".tsx", ".mts"].some((ext) => hasSource(base + ext)))
    .map(
      ({ file, base }) =>
        `${pkg.name}: ${file} has no source (${base}.ts); rebuild from a clean checkout.`,
    )
}

/** Problems with a packed package.json: `workspace:` versions, a name or version mismatch. */
export function manifestProblems(pkg, manifest, version) {
  const problems = []
  if (manifest.name !== pkg.name)
    problems.push(`${pkg.dir}: packed as ${manifest.name}, expected ${pkg.name}.`)
  if (manifest.version !== version)
    problems.push(`${pkg.name}: version ${manifest.version}, expected ${version}.`)
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
      if (/^(workspace|link|file):/.test(String(range)))
        problems.push(`${pkg.name}: ${field}.${dependency} is "${range}" in the tarball.`)
    }
  }
  return problems
}

function run(command, args, options = {}) {
  // npm and pnpm are .cmd scripts on Windows: one command line through the shell, arguments quoted.
  const viaShell = isWindows && /^(npm|npx|pnpm)$/.test(command)
  // cmd.exe would read a quote or a percent sign inside an argument (the temporary folder's path).
  if (viaShell && args.some((arg) => /["%]/.test(arg)))
    throw new Error(`An argument holds " or %, which cmd.exe would read: ${args.join(" ")}`)
  const line = [command, ...args.map((arg) => `"${arg}"`)].join(" ")
  const result = viaShell
    ? spawnSync(line, { shell: true, encoding: "utf8", ...options })
    : spawnSync(command, args, { encoding: "utf8", ...options })
  if (result.status !== 0) {
    throw new Error(
      `${[command, ...args].join(" ")} failed (${result.status}):\n${result.stdout}${result.stderr}`,
    )
  }
  return result.stdout
}

/**
 * The files of a tarball (without the "package/" prefix), their total size and the packed
 * package.json, read in memory (gzip, then the tar headers): nothing is written to disk, so no
 * path inside the archive can point anywhere.
 */
export function readTarball(tarball) {
  const data = gunzipSync(readFileSync(tarball))
  const files = []
  const mapRefs = []
  let size = 0
  let manifest
  for (let offset = 0; offset + 512 <= data.length; ) {
    const header = data.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const field = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/s, "")
    const name = [field(345, 155), field(0, 100)].filter(Boolean).join("/")
    const length = Number.parseInt(field(124, 12).trim() || "0", 8)
    const type = field(156, 1) || "0"
    const body = data.subarray(offset + 512, offset + 512 + length)
    // Only files and folders: any other entry (a link, or a pax header that would rename the next
    // file) could make the list below say something other than what npm unpacks.
    if (type !== "0" && type !== "5")
      throw new Error(`${path.basename(tarball)}: unexpected tar entry type "${type}" (${name})`)
    if (type === "0") {
      const file = name.replace(/^package\//, "")
      files.push(file)
      size += length
      if (file === "package.json") manifest = JSON.parse(body.toString("utf8"))
      if (/\.[cm]?js$/.test(file)) {
        const ref = /^\/\/# sourceMappingURL=(?!data:)(\S+)\s*$/m.exec(body.toString("utf8"))?.[1]
        if (ref) mapRefs.push({ file, map: path.posix.join(path.posix.dirname(file), ref) })
      }
    }
    offset += 512 + Math.ceil(length / 512) * 512
  }
  return { files: files.sort(), size, manifest, mapRefs }
}

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

/**
 * The file an installed package's command runs: from its package.json `bin`, as npm resolves it,
 * and only if npm also made the command (node_modules/.bin), so a broken `bin` fails here.
 */
function commandFile(app, pkgName, command) {
  const dir = path.join(app, "node_modules", ...pkgName.split("/"))
  const manifest = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
  const target = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.[command]
  if (!target) throw new Error(`${pkgName} has no "${command}" command in its bin field`)
  const file = path.join(dir, target)
  if (!existsSync(file))
    throw new Error(
      `${pkgName}: the "${command}" command points at ${target}, which is not in the package`,
    )
  const shim = path.join(app, "node_modules", ".bin", isWindows ? `${command}.cmd` : command)
  if (!existsSync(shim)) throw new Error(`npm made no "${command}" command for ${pkgName}`)
  return file
}

/** Starts `kervan run <spec> --http` from the installed package and asks it for its tools. */
async function listToolsOverHttp(cwd, spec) {
  const port = await freePort()
  const child = spawn(
    process.execPath,
    [commandFile(cwd, "kervan", "kervan"), "run", spec, "--http", "--port", String(port)],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  )
  let output = ""
  child.stdout.on("data", (chunk) => (output += chunk))
  child.stderr.on("data", (chunk) => (output += chunk))
  try {
    for (let i = 0; i < 100 && !/Serving|listening/i.test(output); i++) {
      if (child.exitCode !== null) throw new Error(`kervan run exited:\n${output}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    const meta = {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    }
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: meta },
      }),
    })
    const text = await response.text()
    const body = text.trimStart().startsWith("{")
      ? JSON.parse(text)
      : JSON.parse(
          text
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .at(-1)
            ?.slice(5) ?? "null",
        )
    return body?.result?.tools?.map((tool) => tool.name) ?? []
  } finally {
    child.kill()
  }
}

async function main() {
  const version = JSON.parse(
    readFileSync(path.join(root, PACKAGES[0].dir, "package.json"), "utf8"),
  ).version
  const work = mkdtempSync(path.join(os.tmpdir(), "kervan-pack-"))
  const failures = []
  try {
    // 1-2. Pack and check each package.
    const tarballs = []
    for (const pkg of PACKAGES) {
      const before = new Set(readdirSync(work))
      run("pnpm", ["pack", "--pack-destination", work], { cwd: path.join(root, pkg.dir) })
      const tarball = readdirSync(work).find((name) => name.endsWith(".tgz") && !before.has(name))
      if (!tarball) throw new Error(`${pkg.name}: pnpm pack wrote no tarball`)
      tarballs.push(path.join(work, tarball))
      const packed = readTarball(path.join(work, tarball))
      const problems = [
        ...contentProblems(pkg, packed.files, packed.size),
        ...sourceMapProblems(pkg, packed.files, packed.mapRefs),
        ...orphanProblems(pkg, packed.files, (file) => existsSync(path.join(root, pkg.dir, file))),
        ...manifestProblems(pkg, packed.manifest, version),
      ]
      failures.push(...problems)
      const packedSize = statSync(path.join(work, tarball)).size
      console.log(
        `${problems.length ? "FAIL" : "ok  "} ${tarball}: ${packed.files.length} files, ${packed.size} bytes unpacked, ${packedSize} packed`,
      )
    }
    if (failures.length > 0) throw new Error(failures.join("\n"))

    // 3. A fresh project outside the repository, the tarballs installed as npm would from the registry.
    const app = path.join(work, "app")
    mkdirSync(app)
    writeFileSync(
      path.join(app, "package.json"),
      JSON.stringify({ name: "pack-smoke", private: true, type: "module" }),
    )
    run("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline", ...tarballs], {
      cwd: app,
    })
    const bin = commandFile(app, "kervan", "kervan")

    const help = run(process.execPath, [bin, "--help"], { cwd: app })
    if (!help.startsWith("Usage: kervan <command>"))
      failures.push("kervan --help does not print the usage.")
    const runHelp = run(process.execPath, [bin, "run", "--help"], { cwd: app })
    if (!runHelp.startsWith("Usage: kervan run <spec>"))
      failures.push("kervan run --help does not print its usage.")
    console.log("ok   kervan --help, kervan run --help")

    writeFileSync(
      path.join(app, "smoke.mjs"),
      [
        'import { createApp, z } from "@kervan/core"',
        'import { createTestClient } from "@kervan/transport/testing"',
        'import { loadSpec } from "@kervan/spec-runtime"',
        'const app = createApp({ name: "smoke", version: "0.0.0" })',
        'app.tool("add", { description: "Adds.", input: z.object({ a: z.number(), b: z.number() }), output: z.object({ sum: z.number() }), handler: ({ a, b }) => ({ sum: a + b }) })',
        "const client = await createTestClient(app)",
        'const result = await client.callTool({ name: "add", arguments: { a: 2, b: 3 } })',
        "await client.close()",
        'if (typeof loadSpec !== "function") throw new Error("loadSpec is missing")',
        'console.log("sum: " + result.structuredContent.sum)',
      ].join("\n"),
    )
    const smoke = run(process.execPath, ["smoke.mjs"], { cwd: app })
    if (smoke.trim() !== "sum: 5")
      failures.push(`importing the packages and calling a tool printed: ${smoke}`)
    else
      console.log(
        "ok   import @kervan/core, @kervan/transport/testing, @kervan/spec-runtime; a tool call",
      )

    const spec = path.join(app, "kervan.yaml")
    writeFileSync(spec, readFileSync(path.join(root, "examples", "spec", "kervan.yaml")))
    const tools = await listToolsOverHttp(app, spec)
    if (tools.join(",") !== "search_city,get_current_weather")
      failures.push(`kervan run on the example spec listed: ${tools.join(", ") || "nothing"}`)
    else console.log(`ok   kervan run examples/spec/kervan.yaml: tools/list = ${tools.join(", ")}`)

    // create-kervan makes a project; its dependencies come from the same tarballs, then its tests run.
    run(
      process.execPath,
      [commandFile(app, "create-kervan", "create-kervan"), "made", "--no-install"],
      {
        cwd: work,
      },
    )
    const made = path.join(work, "made")
    run(
      "npm",
      [
        "install",
        "--no-audit",
        "--no-fund",
        "--prefer-offline",
        ...tarballs.filter((t) => !/create-kervan/.test(t)),
      ],
      {
        cwd: made,
      },
    )
    run("npm", ["install", "--no-audit", "--no-fund", "--prefer-offline"], { cwd: made })
    run("npm", ["test"], { cwd: made })
    console.log("ok   create-kervan: a new project installs from the tarballs and its tests pass")
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5 })
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`error: ${failure}`)
    process.exit(1)
  }
  console.log("test:pack passed.")
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`error: ${error.message}`)
    process.exit(1)
  })
}
