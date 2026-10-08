#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { nodeVersionProblem } from "../dist/node-version.js"

// Before loading the rest of Studio: on an untested Node.js, stop with one clear line.
const unsupported = nodeVersionProblem(process.versions.node)
if (unsupported) {
  process.stderr.write(`Error: ${unsupported}\n`)
  process.exit(1)
}

const { runStudioCli } = await import("../dist/cli.js")
const code = await runStudioCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  cwd: process.cwd(),
  readStdin: async () => readFileSync(0, "utf8"),
})
if (code !== 0) process.exitCode = code
