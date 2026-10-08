// Studio's data directory holds the database: encrypted secrets, session and key hashes, the audit
// log. It must never end up in a git repository by accident.
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
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
 * The environment git runs with: no variable that changes what git does (`GIT_DIR`,
 * `GIT_CONFIG_*`, `GIT_EXTERNAL_DIFF`, ...), no system or global config file (so no
 * `safe.directory` exception from them either: a repository owned by another user is refused, and
 * the check is skipped), no prompts and no optional locks (read-only).
 */
export function gitEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {}
  for (const name of KEPT_ENV) if (env[name] !== undefined) clean[name] = env[name]
  return {
    ...clean,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: DEV_NULL,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  }
}

/** The arguments of a read-only git command, with every program-running setting off. */
export function gitArguments(dir: string, args: string[]): string[] {
  return [...NO_PROGRAMS.flatMap((setting) => ["-c", setting]), "-C", dir, ...args]
}

function git(dir: string, args: string[]): boolean | undefined {
  try {
    execFileSync("git", gitArguments(dir, args), {
      stdio: "ignore",
      timeout: 5000,
      env: gitEnvironment(),
    })
    return true
  } catch (error) {
    // No git at all, or it could not run: nothing to say.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    return typeof (error as { status?: number }).status === "number" ? false : undefined
  }
}

/**
 * A warning when the database is inside a git working tree and git would commit it (it is
 * tracked, or not ignored); undefined otherwise, or when git is not available.
 */
export function dataDirectoryGitWarning(dir: string, file: string): string | undefined {
  if (git(dir, ["rev-parse", "--is-inside-work-tree"]) !== true) return undefined
  const name = path.basename(file)
  // SQLite keeps recent pages in `-wal` next to the database (and an index in `-shm`): an ignore
  // rule like `*.db` covers the database but not those.
  const names = [name, `${name}-wal`, `${name}-shm`]
  if (names.some((each) => git(dir, ["ls-files", "--error-unmatch", each]) === true)) {
    return (
      `Warning: ${file} (or its -wal/-shm file) is tracked by git. It holds encrypted secrets, sessions and the audit ` +
      `log: remove it from the repository (git rm --cached) and set KERVAN_STUDIO_DATA_DIR to a ` +
      "folder outside it."
    )
  }
  if (names.some((each) => git(dir, ["check-ignore", "-q", each]) === false)) {
    return (
      `Warning: ${file} (or its -wal/-shm file) is inside a git repository and not ignored, so ` +
      `it could be committed. Add ${path.basename(dir)}/ to .gitignore, or set ` +
      "KERVAN_STUDIO_DATA_DIR to a folder outside the repository."
    )
  }
  return undefined
}
