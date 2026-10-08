import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { NODE_ENGINES } from "./node-version.js"

const templatesDir = fileURLToPath(new URL("../templates/", import.meta.url))

/** Versions written into new projects, next to the CLI's own version for the Kervan packages. */
export const TEMPLATE_VERSIONS = {
  mcpClientVersion: "^2.3.1",
  typesNodeVersion: "^24.0.0",
  typescriptVersion: "^7.0.2",
  vitestVersion: "^5.0.3",
} as const

export function cliVersion(): string {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
  return manifest.version
}

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun"

export interface CreateOptions {
  /** Target directory, absolute or relative to `cwd`. */
  dir: string
  /** Package name. Default: the directory name. */
  name?: string
  template?: string
  install?: boolean
  packageManager?: PackageManager
  cwd?: string
  log?: (line: string) => void
}

export interface CreateResult {
  dir: string
  name: string
  files: string[]
  installed: boolean
  /** The package manager used (or to use) for installing and running scripts. */
  packageManager: PackageManager
}

export class CreateError extends Error {
  override name = "CreateError"
}

/** npm package names: lowercase, URL-safe, optionally scoped, at most 214 characters. */
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

export async function createProject(options: CreateOptions): Promise<CreateResult> {
  const log = options.log ?? (() => {})
  const dir = path.resolve(options.cwd ?? process.cwd(), options.dir)
  const name = options.name ?? path.basename(dir)
  if (name.length > 214 || !PACKAGE_NAME.test(name)) {
    throw new CreateError(
      `"${name}" is not a valid npm package name. Use lowercase letters, digits, "-", "." and "_", ` +
        "or pass --name.",
    )
  }

  const templateDir = path.join(templatesDir, options.template ?? "basic")
  if (!(await isDirectory(templateDir))) {
    throw new CreateError(`Unknown template "${options.template}".`)
  }
  await ensureEmptyDir(dir)

  const values: Record<string, string> = {
    name,
    kervanVersion: cliVersion(),
    nodeEngines: NODE_ENGINES,
    ...TEMPLATE_VERSIONS,
  }
  const files: string[] = []
  for (const relative of await listFiles(templateDir)) {
    // npm drops .gitignore and .npmrc from published packages, so the template stores them as
    // _gitignore and _npmrc.
    const target =
      relative === "_gitignore" ? ".gitignore" : relative === "_npmrc" ? ".npmrc" : relative
    const content = await readFile(path.join(templateDir, relative), "utf8")
    const destination = path.join(dir, target)
    await mkdir(path.dirname(destination), { recursive: true })
    await writeFile(destination, fill(content, values))
    files.push(target.split(path.sep).join("/"))
  }
  log(`Created ${name} in ${dir}`)

  const pm = options.packageManager ?? detectPackageManager()
  let installed = false
  if (options.install !== false) {
    log(`Installing dependencies with ${pm}...`)
    await runInstall(pm, dir)
    installed = true
  }
  return { dir, name, files: files.sort(), installed, packageManager: pm }
}

function fill(content: string, values: Record<string, string>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, key: string) => values[key] ?? match)
}

async function listFiles(root: string, base = ""): Promise<string[]> {
  const entries = await readdir(path.join(root, base), { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const relative = path.join(base, entry.name)
    if (entry.isDirectory()) files.push(...(await listFiles(root, relative)))
    else files.push(relative)
  }
  return files
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory()
  } catch {
    return false
  }
}

async function ensureEmptyDir(dir: string): Promise<void> {
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) throw new CreateError(`${dir} exists and is not a directory.`)
    if ((await readdir(dir)).length > 0) {
      throw new CreateError(`${dir} is not empty. Choose a new directory or empty this one.`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    await mkdir(dir, { recursive: true })
  }
}

/** `npm create`, `pnpm create` etc. set npm_config_user_agent, e.g. "pnpm/12.9.1 npm/? node/...". */
export function detectPackageManager(
  userAgent = process.env.npm_config_user_agent ?? "",
): PackageManager {
  const name = userAgent.split("/")[0]
  return name === "pnpm" || name === "yarn" || name === "bun" ? name : "npm"
}

/**
 * The install's environment on Windows: cmd.exe looks a bare command name up in the current
 * directory (the new project) before PATH, unless NoDefaultCurrentDirectoryInExePath is set.
 */
export function installEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return platform === "win32" ? { ...env, NoDefaultCurrentDirectoryInExePath: "1" } : env
}

function runInstall(pm: PackageManager, cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Package managers are .cmd shims on Windows, which need a shell. The command is one fixed
    // string (pm comes from a closed list), so nothing user-controlled reaches the shell.
    const windows = process.platform === "win32"
    const child = windows
      ? spawn(`${pm} install`, { cwd, stdio: "inherit", shell: true, env: installEnvironment() })
      : spawn(pm, ["install"], { cwd, stdio: "inherit" })
    child.on("error", reject)
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new CreateError(`${pm} install failed with exit code ${code}.`)),
    )
  })
}
