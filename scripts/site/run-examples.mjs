// Runs the documentation's code blocks (`pnpm site:verify --examples`), each as its `check` says
// (scripts/site/docs-examples.mjs lists the kinds). Commands run against this working tree: paths
// such as `packages/cli/bin/kervan.js` are made absolute. `run` blocks run in the tree itself (the
// quickstart's `pnpm build` builds it); everything else runs in a temporary folder that is removed
// afterwards, also on Ctrl+C. A "clone" is a copy of the working tree's files (tracked and
// untracked, without ignored ones), so uncommitted docs are checked as they are.
//
// Without flags only what needs no network and changes nothing outside the tree's build output and
// the temporary folders runs.
//   --network  also blocks that reach the internet (REPL calls, clone and install steps)
//   --claude   also Claude Code commands. They add servers in a temporary project folder (local
//              scope) and remove them again; Claude Code keeps an empty entry for that folder in
//              its configuration.
//   --docker   also the Dockerfile draft (builds and runs an image, then removes it)
import { spawn, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import http from "node:http"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { codeOf } from "./docs-examples.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const isWindows = process.platform === "win32"
// The documented clone command ("git clone <repository>.git kervan"): a copy of the working tree stands in for it.
const CLONE_LINE = /^git clone \S+\.git kervan$/
/** Terminal color codes (ESC [ ... m), which the REPL prints at a terminal. */
const ANSI_COLOR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Lines of a shell block as commands: continuations joined, comments and blank lines dropped. */
export function commandLines(code) {
  return code
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n/)
    .map((line) => stripComment(line).trim())
    .filter((line) => line !== "")
}

function stripComment(line) {
  let quote = ""
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (quote) {
      if (char === quote) quote = ""
    } else if (char === '"' || char === "'") quote = char
    else if (char === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

/** A command line as words (double and single quotes group; no other shell syntax). */
export function words(line) {
  const out = []
  let current = ""
  let quote = ""
  let started = false
  for (const char of line) {
    if (quote) {
      if (char === quote) quote = ""
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      started = true
    } else if (/\s/.test(char)) {
      if (started || current) out.push(current)
      current = ""
      started = false
    } else current += char
  }
  if (quote) throw new Error(`Unclosed quote in: ${line}`)
  if (started || current) out.push(current)
  return out
}

/** The docs' placeholder for the reader's own spec file (POSIX and Windows forms). */
const SPEC_PLACEHOLDER = /^(\/absolute\/path\/to\/kervan\.yaml|C:\\path\\to\\kervan\.yaml)$/i

/**
 * A documented command as a process to start: leading NAME=value words become its environment,
 * `node` is this Node.js, `kervan` the CLI of this tree, and repository paths become absolute.
 * The placeholder for the reader's spec file becomes `spec`, a real file; without one it is an
 * error, never a path that does not exist.
 */
export function toProcess(line, tree = root, { spec } = {}) {
  const parts = words(line)
  const env = {}
  while (parts.length > 0 && /^[A-Z_][A-Z0-9_]*=/.test(parts[0])) {
    const [name, ...value] = parts.shift().split("=")
    env[name] = value.join("=")
  }
  // The published docs show placeholders for a clone's location (POSIX and Windows forms); the
  // check runs with the real one.
  const absolute = (word) =>
    word
      .replace(/^\/absolute\/path\/to\/kervan\//, `${tree}/`)
      .replace(/^C:\\path\\to\\kervan\\/i, `${tree}/`)
      .replaceAll("\\", "/")
      .replace(/^(packages|apps|examples)\//, `${tree}/$1/`)
      .replaceAll("/", path.sep)
  const specFile = (word) => {
    if (!spec) throw new Error(`no spec file for the placeholder ${word} in: ${line}`)
    return spec
  }
  let argv = parts.map((word, index) =>
    index === 0
      ? word
      : SPEC_PLACEHOLDER.test(word)
        ? specFile(word)
        : /^(\/absolute|C:\\path\\to\\|packages\/|apps\/|examples\/)/i.test(word)
          ? absolute(word)
          : word,
  )
  if (argv[0] === "node") argv = [process.execPath, ...argv.slice(1)]
  else if (argv[0] === "kervan")
    argv = [
      process.execPath,
      path.join(tree, "packages", "cli", "bin", "kervan.js"),
      ...argv.slice(1),
    ]
  return { env, argv }
}

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once("error", () => resolve(false))
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)))
  })
}

// What a run leaves behind until it finishes: removed on the way, and on Ctrl+C.
const temps = new Set()
const children = new Set()
const claudeServers = new Map() // name -> project folder

/** A new temporary folder, removed by removeTemp() or when the run is interrupted. */
function tempDir(prefix) {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.add(dir)
  return dir
}

function removeTemp(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  temps.delete(dir)
}

function killTree(child) {
  if (child.exitCode !== null) return
  if (isWindows) spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" })
  else {
    try {
      process.kill(-child.pid, "SIGKILL")
    } catch {}
  }
}

process.once("SIGINT", () => {
  for (const child of children) killTree(child)
  for (const [name, cwd] of claudeServers) {
    spawnSync("claude", ["mcp", "remove", name], { cwd, shell: isWindows, stdio: "ignore" })
  }
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  process.exit(130)
})

/** A long-running process: its output so far, a wait for a text, and a stop that ends its tree. */
function launch(argv, { cwd, env = {} }) {
  const child = spawn(argv[0], argv.slice(1), {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
    detached: !isWindows,
    windowsHide: true,
  })
  children.add(child)
  child.once("exit", () => children.delete(child))
  let output = ""
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => {
    output += chunk
    stdout += chunk
  })
  child.stderr.on("data", (chunk) => {
    output += chunk
    stderr += chunk
  })
  const exited = new Promise((resolve) => child.once("exit", resolve))
  child.once("error", (error) => (output += `\n${error.message}`))
  return {
    child,
    output: () => output.replace(ANSI_COLOR, ""),
    stdout: () => stdout.replace(ANSI_COLOR, ""),
    stderr: () => stderr.replace(ANSI_COLOR, ""),
    async waitFor(text, ms = 30_000) {
      const end = Date.now() + ms
      while (Date.now() < end) {
        if (this.output().includes(text)) return
        if (child.exitCode !== null)
          throw new Error(`exited (${child.exitCode}) before "${text}":\n${this.output()}`)
        await sleep(100)
      }
      throw new Error(`no "${text}" within ${ms / 1000} s:\n${this.output()}`)
    },
    async stop() {
      if (child.exitCode !== null) return
      child.stdin.end()
      const done = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
      if (done) return
      killTree(child)
      await exited
    },
  }
}

/** Runs a command to completion (no shell); throws with its output when it fails. */
function runToEnd(argv, { cwd, env = {}, input, timeout = 600_000 }) {
  // On Windows these are .cmd scripts, which only a shell starts: the words are quoted for cmd.exe.
  const viaShell = isWindows && /^(pnpm|npm|npx|corepack|claude|docker|git)$/.test(argv[0])
  const options = {
    cwd,
    env: { ...process.env, ...env },
    input,
    encoding: "utf8",
    timeout,
    windowsHide: true,
  }
  const result = viaShell
    ? spawnSync(argv.map(cmdQuote).join(" "), { ...options, shell: true })
    : spawnSync(argv[0], argv.slice(1), options)
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`
  if (result.status !== 0)
    throw new Error(
      `\`${argv.join(" ")}\` exited ${result.status ?? result.signal ?? result.error?.message}:\n${output}`,
    )
  return output
}

function cmdQuote(word) {
  if (/["%^&|<>!]/.test(word)) throw new Error(`cannot pass ${word} through cmd.exe`)
  return /[\s]/.test(word) ? `"${word}"` : word
}

/**
 * A documented `kervan dev` command as a terminal runs it. At a terminal it serves HTTP with the
 * inspector; with stdin a pipe (as here) it would serve stdio, so --http --repl says the same.
 */
function asAtTerminal(argv) {
  const dev = argv.findIndex(
    (word, index) => word === "dev" && /kervan\.js$/.test(argv[index - 1] ?? ""),
  )
  if (dev < 0 || argv.includes("--http") || argv.includes("--stdio")) return argv
  return [...argv, "--http", "--repl"]
}

/** Copies the working tree's files (tracked and untracked, without ignored ones) to `dest`. */
export function copyWorkingTree(dest) {
  const listed = runToEnd(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
  })
  for (const file of listed.split("\0").filter(Boolean)) {
    const from = path.join(root, file)
    if (!existsSync(from)) continue // deleted, not yet committed
    const to = path.join(dest, file)
    mkdirSync(path.dirname(to), { recursive: true })
    copyFileSync(from, to)
  }
}

function specFor(blocks, block) {
  const id = block.attrs["data-spec"]
  return blocks.find(
    (other) => other.page === block.page && other.check === "spec" && other.id === id,
  )
}

/** The TypeScript block a REPL transcript also replays against (data-code). */
function codeFor(blocks, block) {
  const id = block.attrs["data-code"]
  return blocks.find(
    (other) =>
      other.page === block.page && other.id === id && ["ts", "ts-run"].includes(other.check),
  )
}

/** A temporary folder with the block's spec (if any) under the name the command uses. */
function workdir(blocks, block, line = "") {
  const dir = tempDir("kervan-docs-")
  const spec = block.attrs["data-spec"] ? specFor(blocks, block) : undefined
  if (spec) {
    const name =
      words(line).find((word) => word.endsWith(".yaml") && !word.includes("/")) ?? `${spec.id}.yaml`
    writeFileSync(path.join(dir, name), codeOf(spec))
  }
  return dir
}

/**
 * Gives dir a node_modules with the CLI package's dependencies (@kervan/* among them), like a
 * project that depends on them: one link per package, straight to its real folder. Not one link
 * to the CLI's node_modules: pnpm makes symbolic links there where Windows allows them (GitHub's
 * runners) and junctions where it does not, and Node's ESM resolver does not find a package
 * through a junction to a folder of symbolic links (ERR_MODULE_NOT_FOUND; CommonJS does).
 */
export function linkCliDependencies(dir) {
  const from = path.join(root, "packages", "cli", "node_modules")
  const names = readdirSync(from)
    .filter((name) => !name.startsWith("."))
    .flatMap((name) =>
      name.startsWith("@")
        ? readdirSync(path.join(from, name)).map((inner) => `${name}/${inner}`)
        : [name],
    )
  for (const name of names) {
    const link = path.join(dir, "node_modules", ...name.split("/"))
    mkdirSync(path.dirname(link), { recursive: true })
    symlinkSync(
      realpathSync(path.join(from, ...name.split("/"))),
      link,
      isWindows ? "junction" : "dir",
    )
  }
}

/** Type-checks `file` in dir (strict, Node types), resolving packages from dir's node_modules. */
function typecheck(dir, file) {
  runToEnd(
    [
      process.execPath,
      path.join(root, "node_modules", "typescript", "bin", "tsc"),
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "es2024",
      "--module",
      "nodenext",
      "--moduleResolution",
      "nodenext",
      "--types",
      "node",
      "--typeRoots",
      path.join(root, "node_modules", "@types"),
      file,
    ],
    { cwd: dir },
  )
}

/**
 * Feeds a REPL transcript's `kervan> ` lines to `kervan dev <entry>` (cli, entry) in dir and
 * checks that each prints the lines under it. Its stdin is a pipe, not a terminal: --http --repl
 * keeps the inspector on.
 */
async function replay(block, [cli, entry], dir) {
  const port = await freePort()
  const argv = [process.execPath, cli, "dev", entry, "--http", "--repl", "--port", String(port)]
  const started = Date.now()
  const proc = launch(argv, { cwd: dir })
  // On failure, everything needed to see why: kervan dev's own output (already redacted by it;
  // redacted again here the same way, for secrets in this process's environment), its exit code,
  // where and how it ran, and how long this waited.
  const failure = async (message) => {
    const { collectSecrets, createRedactor } = await import(
      pathToFileURL(path.join(root, "packages/cli/dist/dev/redact.js")).href
    )
    const redact = createRedactor(collectSecrets(process.env))
    return new Error(
      redact(
        [
          message,
          `--- command: ${argv.join(" ")}`,
          `--- cwd: ${dir}`,
          `--- exit code: ${proc.child.exitCode ?? "still running"}`,
          `--- waited: ${Date.now() - started} ms`,
          `--- stdout:\n${proc.stdout()}`,
          `--- stderr:\n${proc.stderr()}`,
        ].join("\n"),
      ),
    )
  }
  try {
    try {
      await proc.waitFor('Type "help"')
    } catch (error) {
      throw await failure(
        `kervan dev did not start its REPL (${entry}): ${error.message.split("\n")[0]}`,
      )
    }
    const transcript = codeOf(block).split("\n")
    for (let i = 0; i < transcript.length; i++) {
      if (!transcript[i].startsWith("kervan> ")) continue
      const expected = []
      for (let j = i + 1; j < transcript.length && !transcript[j].startsWith("kervan> "); j++)
        expected.push(transcript[j])
      const from = proc.output().length
      proc.child.stdin.write(`${transcript[i].slice("kervan> ".length)}\n`)
      const end = Date.now() + 20_000
      while (!expected.every((line) => proc.output().slice(from).includes(line))) {
        if (Date.now() > end)
          throw await failure(
            `"${transcript[i]}" did not print (${entry}):\n${expected.join("\n")}\n--- got:\n${proc.output().slice(from)}`,
          )
        await sleep(100)
      }
    }
  } finally {
    await proc.stop()
  }
}

const runners = {
  async run(block) {
    for (const line of commandLines(codeOf(block))) {
      const { env, argv } = toProcess(line)
      runToEnd(argv, { cwd: root, env })
    }
  },

  async starts(block, blocks) {
    const lines = commandLines(codeOf(block))
    if (block.attrs["data-each"] === "true") {
      // A temporary copy of the folder they run in, with the empty files they expect.
      const cwd = tempDir("kervan-docs-each-")
      cpSync(path.join(root, block.attrs["data-cwd"] ?? ""), cwd, { recursive: true })
      for (const file of (block.attrs["data-files"] ?? "").split(",").filter(Boolean)) {
        if (!existsSync(path.join(cwd, file))) writeFileSync(path.join(cwd, file), "")
      }
      try {
        for (const line of lines) {
          const { env, argv } = toProcess(line)
          const proc = launch(argv, { cwd, env })
          await sleep(5000)
          const alive = proc.child.exitCode === null
          await proc.stop()
          if (!alive) throw new Error(`\`${line}\` exited:\n${proc.output()}`)
        }
      } finally {
        removeTemp(cwd)
      }
      return
    }
    if (lines.length !== 1) throw new Error("a starts block has one command")
    const dir = workdir(blocks, block, lines[0])
    const { env, argv } = toProcess(lines[0])
    const proc = launch(asAtTerminal(argv), { cwd: block.attrs["data-spec"] ? dir : root, env })
    try {
      await proc.waitFor(block.attrs["data-ready"])
    } finally {
      await proc.stop()
      removeTemp(dir)
    }
  },

  async repl(block, blocks, options = {}) {
    // The spec, with the repository's CLI.
    const spec = specFor(blocks, block)
    const dir = workdir(blocks, block)
    try {
      await replay(block, [path.join(root, "packages/cli/bin/kervan.js"), `${spec.id}.yaml`], dir)
    } finally {
      removeTemp(dir)
    }
    // And, when the transcript names code (data-code), the same transcript against that TypeScript:
    // the same tool written in code must answer the same. Once published, with the packages
    // installed from npm under the site's tag, as a reader would; before, with the repository's.
    const id = block.attrs["data-code"]
    if (!id) return
    const code = codeFor(blocks, block)
    if (!code) throw new Error(`no ts block with id "${id}" on ${block.page}`)
    const codeDir = tempDir("kervan-docs-repl-ts-")
    try {
      writeFileSync(path.join(codeDir, `${id}.ts`), codeOf(code))
      let cli = path.join(root, "packages/cli/bin/kervan.js")
      if (options.published) {
        const tag = options.tag ?? "latest"
        writeFileSync(
          path.join(codeDir, "package.json"),
          '{ "name": "repl-ts", "private": true, "type": "module" }\n',
        )
        runToEnd(
          [
            "npm",
            "install",
            "--no-audit",
            "--no-fund",
            "--registry",
            "https://registry.npmjs.org/",
            `@kervan/core@${tag}`,
            `@kervan/transport@${tag}`,
            `kervan@${tag}`,
          ],
          { cwd: codeDir, timeout: 600_000 },
        )
        cli = path.join(codeDir, "node_modules", "kervan", "bin", "kervan.js")
        // The ts block itself is type-checked against the repository's packages; here against these.
        typecheck(codeDir, `${id}.ts`)
      } else {
        writeFileSync(path.join(codeDir, "package.json"), '{ "type": "module" }\n')
        linkCliDependencies(codeDir)
      }
      await replay(block, [cli, `${id}.ts`], codeDir)
    } finally {
      removeTemp(codeDir)
    }
  },

  async ts(block) {
    const dir = tempDir("kervan-docs-ts-")
    try {
      linkCliDependencies(dir)
      writeFileSync(path.join(dir, "package.json"), '{ "type": "module" }\n')
      writeFileSync(path.join(dir, "example.ts"), codeOf(block))
      typecheck(dir, "example.ts")
      if (block.check === "ts-run") {
        const output = runToEnd([process.execPath, "example.ts"], { cwd: dir })
        if (!output.includes(block.attrs["data-expect"]))
          throw new Error(`printed:\n${output}\nnot "${block.attrs["data-expect"]}"`)
      }
    } finally {
      removeTemp(dir)
    }
  },

  async "studio-starts"(block, blocks) {
    if (!(await portFree(4310))) throw new Error("port 4310 is in use (Studio's default)")
    const [line] = commandLines(codeOf(block))
    const dir = studioDir(block, blocks)
    const { env, argv } = toProcess(line)
    const proc = launch(argv, { cwd: dir, env })
    try {
      await proc.waitFor("Kervan Studio listening")
    } finally {
      await proc.stop()
      removeTemp(dir)
    }
  },

  async "studio-create-admin"(block, blocks) {
    const [line] = commandLines(codeOf(block))
    const dir = studioDir(block, blocks)
    try {
      const { env, argv } = toProcess(line)
      // The documented command asks for the password at a terminal; here it comes from stdin.
      runToEnd([...argv, "--password-stdin"], {
        cwd: dir,
        env,
        input: `${randomBytes(18).toString("base64url")}\n`,
      })
    } finally {
      removeTemp(dir)
    }
  },
}

/**
 * A fresh folder for a Studio command, with the master key file the page's `studio-key` block
 * writes there (by running that block's command in it).
 */
function studioDir(block, blocks) {
  const dir = tempDir("kervan-docs-studio-")
  const key = blocks.find((other) => other.page === block.page && other.check === "studio-key")
  if (!key) throw new Error(`no studio-key block on ${block.page}`)
  for (const line of commandLines(codeOf(key))) {
    const { env, argv } = toProcess(line)
    runToEnd(argv, { cwd: dir, env })
  }
  if (!existsSync(path.join(dir, ".env.studio")))
    throw new Error("the studio-key block wrote no .env.studio")
  return dir
}

/** Install steps: run in a copy of the working tree instead of a clone of the repository. */
async function runInstall(block) {
  const dir = tempDir("kervan-docs-clone-")
  let cwd = dir
  let tree = ""
  try {
    for (const line of commandLines(codeOf(block))) {
      if (CLONE_LINE.test(line)) {
        tree = path.join(dir, "kervan")
        copyWorkingTree(tree)
        continue
      }
      if (line.startsWith("cd ")) {
        cwd = path.resolve(cwd, line.slice(3).trim())
        continue
      }
      // Enabling Corepack writes next to the Node.js installation: not done here (pnpm is on PATH).
      if (line === "corepack enable") continue
      if (line === "npm run dev") {
        // `kervan dev` as at a terminal (see asAtTerminal): HTTP with the inspector.
        const proc = launch(
          isWindows
            ? ["cmd.exe", "/d", "/s", "/c", "npm run dev -- --http --repl"]
            : ["npm", "run", "dev", "--", "--http", "--repl"],
          { cwd },
        )
        try {
          await proc.waitFor("Kervan dev server", 120_000)
        } finally {
          await proc.stop()
        }
        continue
      }
      const { env, argv } = toProcess(line, tree || root)
      runToEnd(argv, { cwd, env, timeout: 1_200_000 })
    }
  } finally {
    removeTemp(dir)
  }
}

/** The Claude Code guide, in order, in a temporary project folder; servers removed at the end. */
async function runClaudePage(pageBlocks) {
  const dir = tempDir("kervan-docs-claude-")
  // The reader's spec file (the docs' placeholder path): the repository's example, copied here.
  const spec = path.join(dir, "kervan.yaml")
  copyFileSync(path.join(root, "examples", "spec", "kervan.yaml"), spec)
  let server
  try {
    for (const block of pageBlocks) {
      if (block.check === "starts") {
        if (!(await portFree(3000))) throw new Error("port 3000 is in use")
        const { env, argv } = toProcess(commandLines(codeOf(block))[0])
        server = launch(argv, { cwd: root, env })
        await server.waitFor(block.attrs["data-ready"])
        continue
      }
      for (const line of commandLines(codeOf(block))) {
        const { env, argv } = toProcess(line, root, { spec })
        if (argv[0] !== "claude") continue
        // Recorded before it runs, so an interrupted add is removed too.
        if (argv[2] === "add") {
          const name = argv.find(
            (word, index) =>
              index > 2 && !word.startsWith("-") && argv[index - 1] !== "--transport",
          )
          claudeServers.set(name, dir)
        }
        const output = runToEnd(argv, { cwd: dir, env, timeout: 120_000 })
        if (argv[2] === "remove") claudeServers.delete(argv[3])
        if (argv[2] === "get" && !/Connected/.test(output))
          throw new Error(`\`${line}\` does not say Connected:\n${output}`)
      }
    }
  } finally {
    for (const [name, cwd] of claudeServers) {
      spawnSync("claude", ["mcp", "remove", name], { cwd, shell: isWindows, stdio: "ignore" })
      claudeServers.delete(name)
    }
    await server?.stop()
    removeTemp(dir)
  }
}

/** The Dockerfile draft: built from a copy of the working tree, run read-only, asked over HTTP. */
async function runDocker(dockerfile, runBlock) {
  const dir = tempDir("kervan-docs-docker-")
  const tag = "kervan-docs-check"
  try {
    copyWorkingTree(dir)
    writeFileSync(path.join(dir, "Dockerfile"), codeOf(dockerfile))
    mkdirSync(path.join(dir, "deploy"), { recursive: true })
    copyFileSync(
      path.join(root, "examples", "spec", "kervan.yaml"),
      path.join(dir, "deploy", "kervan.yaml"),
    )
    runToEnd(["docker", "build", "-q", "-t", tag, "."], { cwd: dir, timeout: 1_800_000 })
    // The documented `docker run`, detached and with this check's own name and port.
    const port = await freePort()
    const [build, run] = commandLines(codeOf(runBlock))
    if (
      !build.startsWith("docker build") ||
      !run.startsWith("docker run --rm -p 127.0.0.1:3000:3000")
    )
      throw new Error("unexpected docker-run block")
    const args = words(run)
      .slice(2)
      .map((word) =>
        word.replace("127.0.0.1:3000:3000", `127.0.0.1:${port}:3000`).replace("my-mcp-server", tag),
      )
    runToEnd(["docker", "run", "-d", "--name", tag, ...args], { cwd: dir })
    try {
      const ask = async (host) => {
        for (let i = 0; i < 60; i++) {
          try {
            return await discover(port, host)
          } catch {
            await sleep(500)
          }
        }
        throw new Error("the container did not answer")
      }
      const allowed = await ask("mcp.example.com")
      if (allowed.status !== 200)
        throw new Error(`server/discover with the allowed host: ${allowed.status} ${allowed.body}`)
      const other = await ask("other.example.com")
      if (other.status !== 403)
        throw new Error(`another Host header was answered with ${other.status}, not 403`)
    } finally {
      spawnSync("docker", ["rm", "-f", tag], { stdio: "ignore" })
    }
  } finally {
    spawnSync("docker", ["rmi", "-f", tag], { stdio: "ignore" })
    removeTemp(dir)
  }
}

/** POSTs server/discover with a given Host header (fetch does not let a caller set Host). */
function discover(port, host) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  })
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        headers: {
          host,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "server/discover",
        },
      },
      (response) => {
        let text = ""
        response.on("data", (chunk) => (text += chunk))
        response.on("end", () => resolve({ status: response.statusCode, body: text }))
      },
    )
    request.on("error", reject)
    request.end(body)
  })
}

/**
 * A Claude Code command among the install steps (`claude mcp add ...`): from source before the
 * release, from npm after it. It needs the `claude` CLI, so it runs only with --claude.
 */
const isClaudeInstall = (block) =>
  (block.check === "source" || block.check === "published") && codeOf(block).startsWith("claude ")

/** Runs every runnable block; returns [{ where, kind, status: "ok" | "skipped" | "failed", detail }]. */
export async function runExamples(
  blocks,
  {
    network = false,
    claude = false,
    docker = false,
    published = false,
    tag = "latest",
    log = console.log,
  } = {},
) {
  const results = []
  const seen = new Set()
  const record = (block, status, detail = "") => {
    const where = `${block.page} ${block.check} "${codeOf(block).split("\n")[0].slice(0, 60)}"`
    results.push({ where, status, detail })
    log(
      `${status === "ok" ? "ok     " : status === "skipped" ? "skipped" : "FAILED "} ${where}${detail && status !== "ok" ? ` (${detail.split("\n")[0]})` : ""}`,
    )
  }
  const attempt = async (block, fn) => {
    try {
      await fn()
      record(block, "ok")
    } catch (error) {
      record(block, "failed", error instanceof Error ? error.message : String(error))
    }
  }

  // Claude Code: the connect guide, as one sequence (it adds, checks and removes servers).
  const claudePages = [
    ...new Set(blocks.filter((block) => block.check === "claude").map((block) => block.page)),
  ]
  for (const page of claudePages) {
    const sequence = blocks.filter(
      (block) =>
        block.page === page &&
        (block.check === "claude" || block.check === "starts" || isClaudeInstall(block)),
    )
    for (const block of sequence) seen.add(block)
    if (claude) await attempt(sequence[0], () => runClaudePage(sequence))
    else {
      for (const block of sequence.filter((block) => block.check !== "starts")) {
        record(block, "skipped", "Claude Code commands run with --claude")
      }
    }
    // The page's server command is still checked on its own.
    for (const block of sequence.filter((block) => block.check === "starts"))
      await attempt(block, () => runners.starts(block, blocks))
  }

  for (const block of blocks) {
    if (seen.has(block) || block.check === undefined) continue
    const key = `${block.check}\0${codeOf(block)}\0${block.attrs["data-spec"] ? codeOf(specFor(blocks, block) ?? block) : ""}\0${block.attrs["data-code"] ? codeOf(codeFor(blocks, block) ?? block) : ""}`
    if (seen.has(key)) continue
    seen.add(key)
    const needsNetwork =
      block.attrs["data-network"] === "true" || ["source", "clone"].includes(block.check)
    // Checked by pnpm test, not runnable, or run as part of the Studio blocks (studio-key).
    if (["spec", "fragment", "ts-syntax", "manual", "output", "studio-key"].includes(block.check))
      continue // pnpm test, or not runnable
    if (block.check === "published" && !published) continue
    if (block.check === "source" && published) continue
    if (needsNetwork && !network) {
      record(block, "skipped", "needs the network (--network)")
      continue
    }
    if (isClaudeInstall(block)) {
      record(block, "skipped", "Claude Code commands run with --claude (connect guide)")
      continue
    }
    if (block.check === "docker") continue // with its docker-run block
    if (block.check === "docker-run") {
      const dockerfile = blocks.find(
        (other) => other.page === block.page && other.check === "docker" && other.id === block.id,
      )
      if (!docker) record(block, "skipped", "Docker runs with --docker")
      else await attempt(block, () => runDocker(dockerfile, block))
      continue
    }
    if (block.check === "source" || block.check === "clone" || block.check === "published") {
      await attempt(block, () => runInstall(block))
      continue
    }
    const runner = runners[block.check === "ts-run" ? "ts" : block.check]
    if (!runner) {
      record(block, "failed", `no runner for "${block.check}"`)
      continue
    }
    await attempt(block, () => runner(block, blocks, { published, tag }))
  }
  return results
}
