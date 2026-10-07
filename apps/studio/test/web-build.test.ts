// The web UI build ships the app only: the styleguide is a development page (styleguide.html,
// served by `vite` during development) and must never be in dist-web.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const distWeb = fileURLToPath(new URL("../dist-web", import.meta.url))

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? files(full) : [full]
  })
}

describe("the built web UI", () => {
  // The full check (build, then test) always has dist-web; a bare `vitest` run may not.
  it.runIf(existsSync(distWeb))("contains no styleguide", () => {
    const all = files(distWeb)
    expect(all.filter((file) => /styleguide/i.test(path.basename(file)))).toEqual([])
    const leaking = all
      .filter((file) => /\.(html|js|css)$/.test(file))
      .filter((file) => readFileSync(file, "utf8").includes("Kervan Studio design system"))
    expect(leaking).toEqual([])
  })
})
