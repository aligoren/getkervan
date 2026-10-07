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

function git(dir: string, args: string[]): boolean | undefined {
  try {
    execFileSync("git", ["-C", dir, ...args], { stdio: "ignore", timeout: 5000 })
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
  if (git(dir, ["ls-files", "--error-unmatch", name]) === true) {
    return (
      `Warning: ${file} is tracked by git. It holds encrypted secrets, sessions and the audit ` +
      `log: remove it from the repository (git rm --cached) and set KERVAN_STUDIO_DATA_DIR to a ` +
      "folder outside it."
    )
  }
  if (git(dir, ["check-ignore", "-q", name]) === false) {
    return (
      `Warning: ${file} is inside a git repository and not ignored, so it could be committed. ` +
      `Add ${path.basename(dir)}/ to .gitignore, or set KERVAN_STUDIO_DATA_DIR to a folder ` +
      "outside the repository."
    )
  }
  return undefined
}
