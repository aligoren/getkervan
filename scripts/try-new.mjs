// `pnpm try:new <dir>`: a new project from this repository, before the packages are on npm.
// Builds the packages, creates the project (kervan create --no-install), packs the local
// packages into <dir>/.kervan-tarballs, installs them with npm, and runs the project's tests.
//
// Temporary: once the packages are published, `npm create kervan@latest` replaces this script.
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PACKAGES = ["kervan-core", "kervan-transport", "kervan-spec-runtime", "kervan"]
export const TARBALLS = ".kervan-tarballs"

/** The steps, as commands (for --dry-run and for running). */
export function plan(target, version) {
  const files = PACKAGES.map((name) => path.join(TARBALLS, `${name}-${version}.tgz`))
  return [
    { title: "Build the packages", cwd: root, command: "pnpm", args: ["exec", "tsc", "-b"] },
    {
      title: "Create the project",
      cwd: root,
      command: process.execPath,
      args: [path.join(root, "packages/cli/bin/kervan.js"), "create", target, "--no-install"],
    },
    {
      title: "Pack the local packages",
      cwd: root,
      command: "pnpm",
      args: [
        "-r",
        "--filter",
        "./packages/*",
        "pack",
        "--pack-destination",
        path.join(target, TARBALLS),
      ],
    },
    // All four together: the CLI depends on the spec runtime.
    { title: "Install them", cwd: target, command: "npm", args: ["install", ...files] },
    { title: "Run the project's tests", cwd: target, command: "npm", args: ["test"] },
  ]
}

/** A path as it is typed in a shell: quoted when it has spaces. */
const shown = (value) => (/\s/.test(value) ? `"${value}"` : value)

function usage(message) {
  console.error(`Error: ${message}\nUsage: pnpm try:new <dir> [--dry-run]`)
  return 1
}

export function main(argv, cwd = process.env.INIT_CWD ?? process.cwd()) {
  const dryRun = argv.includes("--dry-run")
  const [dir] = argv.filter((arg) => arg !== "--dry-run")
  if (!dir) return usage("Give the folder for the new project.")
  // pnpm runs scripts from the repository root; INIT_CWD is where the command was typed.
  const target = path.resolve(cwd, dir)
  // On Windows npm and pnpm run through cmd.exe, where every argument is quoted below; inside
  // quotes, cmd.exe still expands %NAME%, and a quote would end the argument.
  if (process.platform === "win32" && /["%]/.test(target)) {
    return usage(`${target}: choose a folder whose path has no " or % in it.`)
  }
  if (existsSync(target) && readdirSync(target).length > 0) {
    return usage(`${target} is not empty.`)
  }
  const { version } = JSON.parse(readFileSync(path.join(root, "packages/cli/package.json"), "utf8"))
  const steps = plan(target, version)
  for (const [index, step] of steps.entries()) {
    console.log(
      `[${index + 1}/${steps.length}] ${step.title}: ${[path.basename(step.command), ...step.args].join(" ")}`,
    )
    if (dryRun) continue
    if (step.title === "Pack the local packages")
      mkdirSync(path.join(target, TARBALLS), { recursive: true })
    // npm and pnpm are .cmd scripts on Windows: run one command line through the shell, every
    // argument in quotes, so "&", "|", "<", ">" and "^" in a path stay part of it.
    const shell = process.platform === "win32" && step.command !== process.execPath
    const result = shell
      ? spawnSync([step.command, ...step.args].map((arg) => `"${arg}"`).join(" "), {
          cwd: step.cwd,
          stdio: "inherit",
          shell: true,
        })
      : spawnSync(step.command, step.args, { cwd: step.cwd, stdio: "inherit" })
    if (result.status !== 0) {
      console.error(`Error: "${step.title}" failed (exit ${result.status ?? result.signal}).`)
      return 1
    }
  }
  console.log(
    dryRun
      ? "Dry run: nothing was changed."
      : `\nReady. Next:\n  cd ${shown(path.relative(cwd, target) || ".")}\n  npm run dev`,
  )
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
