#!/usr/bin/env node
import { readFileSync } from "node:fs"
import { runStudioCli } from "../dist/cli.js"

const code = await runStudioCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  env: process.env,
  cwd: process.cwd(),
  readStdin: async () => readFileSync(0, "utf8"),
})
if (code !== 0) process.exitCode = code
