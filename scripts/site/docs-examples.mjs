// The documentation's code blocks, and how each one is verified. Every block of a command or
// program language carries `check` (set in the Markdown, e.g. ```sh {check="run"}): how it is
// verified, or why it cannot be (`manual` with a `reason`). `pnpm test` checks the declarations,
// that every spec loads and every fragment parses (fast, no network). `pnpm site:verify --examples`
// runs the commands in a clean clone (scripts/site/verify.mjs).
//
// Kinds:
//   spec        a complete kervan.yaml: it must load (and, with an id, other blocks run it)
//   fragment    part of a spec or config: it must parse as YAML
//   run         shell commands that must exit 0
//   starts      a long-running command: it must print `ready` within 30 s (then it is stopped);
//               with each="true" every line is one command that must still be running after 5 s
//               (cwd: where they run; files: empty files they expect, e.g. an .env)
//   repl        a kervan dev REPL transcript: the `kervan> ` lines are fed to it
//   ts, ts-run  TypeScript: it must type-check; ts-run must also run and print `expect`
//   ts-syntax   a TypeScript excerpt that uses names from its surroundings: it must parse
//   studio-starts, studio-create-admin   Studio's own commands, run with a throwaway data folder
//   claude      Claude Code commands (only with --claude: they write to the user's Claude config)
//   docker, docker-run   the Dockerfile draft, built and queried (only with --docker)
//   source, clone, published   install steps from the site's settings (see verify.mjs)
//   manual      not runnable here; `reason` says why
//   output      text a command printed (shown, not run)
import { decodeEntities, tags } from "../check-site.mjs"

export const CHECKS = new Set([
  "spec",
  "fragment",
  "run",
  "starts",
  "repl",
  "ts",
  "ts-run",
  "studio-starts",
  "studio-create-admin",
  "claude",
  "docker",
  "docker-run",
  "source",
  "clone",
  "published",
  "manual",
  "ts-syntax",
])

/** Languages whose blocks must declare how they are verified. */
const MUST_DECLARE = new Set([
  "sh",
  "bash",
  "shell",
  "powershell",
  "ps1",
  "dockerfile",
  "caddyfile",
  "ts",
  "typescript",
  "js",
  "yaml",
])

/** Every `.code` block of the built pages: page, language, check, id, attributes and markup. */
export function collectBlocks(view) {
  const blocks = []
  for (const file of [...view.files].filter((name) => name.endsWith(".html")).sort()) {
    const html = view.text(file)
    for (const match of html.matchAll(/<div class="?code"?((?:\s[^>]*)?)>([\s\S]*?)<\/pre>/g)) {
      const opening = `<div ${match[1]}>`
      const attrs = tags(opening, "div")[0]?.attrs ?? {}
      const pre = /<pre[\s\S]*$/.exec(match[2])?.[0] ?? ""
      blocks.push({
        page: `/${file.replace(/index\.html$/, "")}`,
        lang: attrs["data-lang"] ?? "text",
        check: attrs["data-check"],
        id: attrs["data-id"] ?? attrs["data-example"],
        attrs,
        raw: pre,
      })
    }
  }
  return blocks
}

/** The code of a block, as written (the highlighter keeps each line's break inside its span). */
export function codeOf(block) {
  return decodeEntities(block.raw.replace(/<[^>]+>/g, "")).replace(/\n$/, "")
}

/** Declarations that are missing or wrong (no running, no network). */
export function declarationProblems(blocks) {
  const problems = []
  const specs = new Set(
    blocks
      .filter((block) => block.check === "spec" && block.id)
      .map((block) => `${block.page}#${block.id}`),
  )
  for (const block of blocks) {
    const where = `${block.page} (${block.lang} block "${codeOf(block).split("\n")[0].slice(0, 50)}")`
    const attr = (name) => block.attrs[`data-${name}`]
    if (block.check === undefined) {
      if (MUST_DECLARE.has(block.lang) && attr("example") === undefined) {
        problems.push(`${where}: does not say how it is verified (add {check="..."}).`)
      }
      continue
    }
    if (!CHECKS.has(block.check)) problems.push(`${where}: unknown check "${block.check}".`)
    if (block.check === "manual" && !attr("reason"))
      problems.push(`${where}: a manual block needs a reason.`)
    if (block.check === "starts" && !attr("ready") && attr("each") !== "true")
      problems.push(`${where}: starts needs the ready text it waits for.`)
    if (block.check === "ts-run" && !attr("expect"))
      problems.push(`${where}: ts-run needs the expected output.`)
    if (block.check === "repl" && !attr("spec"))
      problems.push(`${where}: a REPL transcript names the spec it runs.`)
    if (attr("spec") !== undefined && !specs.has(`${block.page}#${attr("spec")}`)) {
      problems.push(`${where}: no spec block with id "${attr("spec")}" on this page.`)
    }
    if (attr("network") !== undefined && attr("network") !== "true")
      problems.push(`${where}: network is "true" or absent.`)
  }
  return problems
}
