import { parseArgs } from "node:util"
import { CreateError, cliVersion, createProject, type PackageManager } from "./create.js"
import { defaultDevOptions, runDev } from "./dev/index.js"
import { currentRuntime, type RuntimeInfo, typeStrippingProblem } from "./node-version.js"

export {
  CreateError,
  type CreateOptions,
  type CreateResult,
  createProject,
  type PackageManager,
} from "./create.js"
export {
  type RuntimeInfo,
  supportsTypeStripping,
  TYPE_STRIPPING_ENGINES,
  typeStrippingProblem,
  windowsLibuvWarning,
} from "./node-version.js"

const HELP = `Usage: kervan <command> [options]

Commands:
  create <dir>   Create a new Kervan MCP server project
    --name <name>        Package name (default: the directory name)
    --pm <manager>       npm, pnpm, yarn or bun (default: the one running this command, else npm)
    --no-install         Skip installing dependencies
  dev <entry>    Run a server with hot reload
    --http               Serve on http://127.0.0.1:<port>/mcp with a REPL (default in a terminal)
    --stdio              Serve on stdin/stdout (default when started by an MCP client)
    --port <port>        HTTP port (default 3000)
    --drain-timeout <ms> How long a reload waits for running calls (default 10000)
    --repl / --no-repl   Force the terminal inspector on or off
    --no-watch           Do not restart on file changes

Options:
  -h, --help     Show this help
  -v, --version  Show the version
`

export interface RunIo {
  out: (line: string) => void
  err: (line: string) => void
  /** The Node.js runtime to check. Default: the current process. */
  runtime?: RuntimeInfo
}

const defaultIo: RunIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}

/** Runs the CLI and returns the exit code. */
export async function run(argv: string[], io: RunIo = defaultIo): Promise<number> {
  const [command, ...rest] = argv
  if (command === undefined || command === "-h" || command === "--help" || command === "help") {
    io.out(HELP)
    return command === undefined ? 1 : 0
  }
  if (command === "-v" || command === "--version") {
    io.out(cliVersion())
    return 0
  }
  try {
    if (command === "dev") return await runDevCommand(rest, io)
    if (command === "create") {
      // Checked before parsing, so old Node.js versions get this message, not a parse error.
      const problem = typeStrippingProblem(io.runtime ?? currentRuntime())
      if (problem) {
        io.err(`Error: ${problem}`)
        return 1
      }
      return await runCreate(rest, io)
    }
    io.err(`Unknown command "${command}".\n\n${HELP}`)
    return 1
  } catch (error) {
    if (error instanceof CreateError || error instanceof UsageError) {
      io.err(`Error: ${error.message}`)
      return 1
    }
    throw error
  }
}

class UsageError extends Error {}

async function runDevCommand(argv: string[], io: RunIo): Promise<number> {
  const { values, positionals } = parseUsage(argv, {
    http: { type: "boolean" },
    stdio: { type: "boolean" },
    port: { type: "string" },
    "drain-timeout": { type: "string" },
    repl: { type: "boolean" },
    watch: { type: "boolean", default: true },
  })
  const [entry] = positionals
  if (!entry || positionals.length > 1) {
    throw new UsageError("Usage: kervan dev <entry> [--http | --stdio] [--port <port>]")
  }
  if (values.http && values.stdio) throw new UsageError("Use either --http or --stdio, not both.")
  const options = defaultDevOptions(entry)
  if (values.http) options.mode = "http"
  if (values.stdio) options.mode = "stdio"
  options.repl = options.mode === "http" && (values.repl ?? options.repl) === true
  options.watch = values.watch !== false
  options.port = parseNumber(values.port, "--port", options.port, true)
  options.drainTimeoutMs = parseNumber(
    values["drain-timeout"],
    "--drain-timeout",
    options.drainTimeoutMs,
  )
  if (io.runtime) options.runtime = io.runtime
  return runDev(options)
}

function parseNumber(raw: unknown, flag: string, fallback: number, allowZero = false): number {
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new UsageError(`${flag} must be a ${allowZero ? "non-negative" : "positive"} integer.`)
  }
  return value
}

async function runCreate(argv: string[], io: RunIo): Promise<number> {
  const { values, positionals } = parseUsage(argv, {
    name: { type: "string" },
    pm: { type: "string" },
    install: { type: "boolean", default: true },
  })
  const [dir] = positionals
  if (!dir || positionals.length > 1) {
    throw new UsageError(
      "Usage: kervan create <dir> [--name <name>] [--pm <manager>] [--no-install]",
    )
  }
  const pm = values.pm as string | undefined
  if (pm !== undefined && !["npm", "pnpm", "yarn", "bun"].includes(pm)) {
    throw new UsageError(`--pm must be npm, pnpm, yarn or bun, not "${pm}".`)
  }
  const result = await createProject({
    dir,
    ...(values.name === undefined ? {} : { name: values.name as string }),
    ...(pm === undefined ? {} : { packageManager: pm as PackageManager }),
    install: values.install !== false,
    log: io.out,
  })
  const relative = dir.includes(" ") ? `"${dir}"` : dir
  io.out(
    [
      "",
      "Next steps:",
      `  cd ${relative}`,
      ...(result.installed ? [] : ["  npm install"]),
      "  npm run dev",
    ].join("\n"),
  )
  return 0
}

type Spec = Record<string, { type: "string" | "boolean"; default?: string | boolean }>

function parseUsage(argv: string[], options: Spec) {
  try {
    return parseArgs({
      args: argv,
      options,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}
