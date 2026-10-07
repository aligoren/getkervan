// Security review (release, supply chain): what `npm pack` puts in each publishable package. Every
// package says "license": "MIT", and the MIT license asks that its notice ship with every copy;
// npm takes a LICENSE file only from the package's own folder.
import { execSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")
const PACKAGES = ["core", "transport", "spec-runtime", "cli", "create-kervan"]

function packedFiles(dir: string): string[] {
  // A fixed command line; nothing from outside reaches the shell.
  const out = execSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 60_000,
  })
  const [info] = JSON.parse(out) as { files: { path: string }[] }[]
  return (info?.files ?? []).map((file) => file.path)
}

describe("packed tarballs", () => {
  it.each(PACKAGES)("%s ships its license text", { timeout: 90_000 }, (name) => {
    const files = packedFiles(path.join(root, "packages", name))
    expect(files.length).toBeGreaterThan(0)
    expect(files.filter((file) => /^licen[cs]e(\.md|\.txt)?$/i.test(file))).toHaveLength(1)
  })
})
