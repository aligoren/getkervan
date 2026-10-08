// Studio's data directory holds the database: encrypted secrets, session and key hashes, the audit
// log. It must never end up in a git repository by accident.
import { execFileSync } from "node:child_process"
import { lstatSync, readdirSync, readFileSync, type Stats, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * Writes a `.gitignore` that ignores everything into a data directory Studio has just created.
 * An existing `.gitignore` is left as it is; a directory Studio did not create gets none (it may
 * be a folder with other content, even a repository root, where "*" would hide everything).
 */
export function ignoreNewDataDirectory(dir: string): void {
  try {
    writeFileSync(
      path.join(dir, ".gitignore"),
      "# Kervan Studio's data (database, encrypted secrets): never commit it.\n*\n",
      { flag: "wx" },
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
}

/** Git for Windows reads "/dev/null" as NUL (it refuses Windows' own name for it). */
const DEV_NULL = "/dev/null"

/**
 * Settings that make git run a program: a repository's own `.git/config` can set them, and the
 * data directory may sit in a tree someone else prepared (an extracted archive). Turned off on the
 * command line, which overrides every config file.
 */
const NO_PROGRAMS = [
  "core.fsmonitor=false",
  `core.hooksPath=${DEV_NULL}`,
  "core.askPass=",
  "credential.helper=",
  "diff.external=",
  "protocol.allow=never",
]

/** Variables git needs to start (Windows needs its system folders); every `GIT_*` one is dropped. */
const KEPT_ENV = ["PATH", "Path", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP", "LANG"]

/**
 * The environment git runs with: no variable of Studio's that changes what git does (`GIT_DIR`,
 * `GIT_CONFIG_*`, `GIT_EXTERNAL_DIFF`, ...), no system or global config file, no prompts and no
 * optional locks (read-only). `repository` names the one repository git may use, so git does not
 * go looking for one (and follow a `.git` file) by itself.
 */
export function gitEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  repository?: { gitDir: string; workTree: string },
): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const name of KEPT_ENV) if (env[name] !== undefined) clean[name] = env[name]
  return {
    ...clean,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: DEV_NULL,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    ...(repository ? { GIT_DIR: repository.gitDir, GIT_WORK_TREE: repository.workTree } : {}),
  }
}

/** The arguments of a read-only git command, with every program-running setting off. */
export function gitArguments(dir: string, args: string[]): string[] {
  return [...NO_PROGRAMS.flatMap((setting) => ["-c", setting]), "-C", dir, ...args]
}

interface Repository {
  workTree: string
  gitDir: string
  stat: Stats
}

/** The nearest folder at or above `dir` with a `.git` entry (not followed, not read). */
function findRepository(dir: string): Repository | undefined {
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    const gitDir = path.join(current, ".git")
    try {
      return { workTree: current, gitDir, stat: lstatSync(gitDir) }
    } catch {
      // Not here.
    }
    if (path.dirname(current) === current) return undefined
  }
}

/**
 * Config keys that make git open a file the repository chooses. On Windows a `//host/share` path
 * is opened over SMB, which hands the user's NTLM credentials to `host`; elsewhere a FIFO can
 * block git.
 */
const NAMES_FILES = /include|excludesfile|attributesfile|worktree/i

/**
 * Whether git may be run on this repository: a real `.git` directory (a `.git` file points git
 * anywhere, even across the network, and git opens it before any ownership check), owned by this
 * user (POSIX), with no symbolic link among its files (`config`, `index`, `info/exclude`, ...) and
 * no config key that names a file elsewhere (`include.path`, `core.excludesFile`, ...).
 */
function safeToInspect(repository: Repository): boolean {
  const { gitDir, stat } = repository
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false
  if (process.getuid && stat.uid !== process.getuid()) return false
  try {
    for (const folder of [gitDir, path.join(gitDir, "info")]) {
      let entries: string[]
      try {
        entries = readdirSync(folder)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (lstatSync(path.join(folder, entry)).isSymbolicLink()) return false
      }
    }
    // Linked worktrees read the rest of the repository from elsewhere.
    if (readdirSync(gitDir).includes("commondir")) return false
    const config = (() => {
      try {
        return readFileSync(path.join(gitDir, "config"), "utf8")
      } catch {
        return ""
      }
    })()
    return !NAMES_FILES.test(config)
  } catch {
    return false
  }
}

function git(repository: Repository, dir: string, args: string[]): boolean | undefined {
  try {
    execFileSync("git", gitArguments(dir, args), {
      stdio: "ignore",
      timeout: 5000,
      env: gitEnvironment(process.env, repository),
    })
    return true
  } catch (error) {
    // No git at all, or it could not run: nothing to say.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    return typeof (error as { status?: number }).status === "number" ? false : undefined
  }
}

/** Whether the data directory's own `.gitignore` ignores everything in it (Studio writes one). */
function ignoresEverything(dir: string): boolean {
  try {
    return readFileSync(path.join(dir, ".gitignore"), "utf8")
      .split(/\r?\n/)
      .some((line) => line.trim() === "*")
  } catch {
    return false
  }
}

/**
 * A warning when the database is inside a git working tree and git would commit it (it is
 * tracked, or not ignored); undefined otherwise, or when git is not available.
 *
 * Git runs only on a repository that cannot make it open files elsewhere (`safeToInspect`); for
 * any other repository Studio does not run git, and warns unless the data directory ignores
 * everything in it.
 */
export function dataDirectoryGitWarning(dir: string, file: string): string | undefined {
  const repository = findRepository(dir)
  if (!repository) return undefined
  if (!safeToInspect(repository)) {
    if (ignoresEverything(dir)) return undefined
    return (
      `Warning: ${file} is inside a git working tree (${repository.workTree}) that Studio does ` +
      "not inspect (its .git is a file or a link, belongs to another user, or its configuration " +
      "names other files). Make sure git ignores the data directory (a .gitignore containing * " +
      "in it), or set KERVAN_STUDIO_DATA_DIR to a folder outside the repository."
    )
  }
  const name = path.basename(file)
  // SQLite keeps recent pages in `-wal` next to the database (and an index in `-shm`): an ignore
  // rule like `*.db` covers the database but not those.
  const names = [name, `${name}-wal`, `${name}-shm`]
  if (names.some((each) => git(repository, dir, ["ls-files", "--error-unmatch", each]) === true)) {
    return (
      `Warning: ${file} (or its -wal/-shm file) is tracked by git. It holds encrypted secrets, sessions and the audit ` +
      `log: remove it from the repository (git rm --cached) and set KERVAN_STUDIO_DATA_DIR to a ` +
      "folder outside it."
    )
  }
  if (names.some((each) => git(repository, dir, ["check-ignore", "-q", each]) === false)) {
    return (
      `Warning: ${file} (or its -wal/-shm file) is inside a git repository and not ignored, so ` +
      `it could be committed. Add ${path.basename(dir)}/ to .gitignore, or set ` +
      "KERVAN_STUDIO_DATA_DIR to a folder outside the repository."
    )
  }
  return undefined
}
