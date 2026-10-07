import path from "node:path"
import { parseArgs } from "node:util"
import { ConfigError, loadConfig } from "./config.js"
import { hashPassword, passwordProblem, randomToken } from "./crypto.js"
import { DatabaseError, openDatabase, writeTransaction } from "./db/open.js"
import { recordAudit } from "./db/repos/audit.js"
import {
  deleteSessionsOf,
  listAdmins,
  normalizeEmail,
  setDisabledAt,
  setPasswordHash,
} from "./db/repos/users.js"
import { defaultWorkspace } from "./db/repos/workspaces.js"
import { envKeyProvider, KeyError } from "./keys.js"
import { DATABASE_FILE, startStudio } from "./server.js"
import { VaultError } from "./vault.js"

export interface StudioCliIo {
  out: (line: string) => void
  err: (line: string) => void
  env: NodeJS.ProcessEnv
  cwd: string
  /** Reads all of stdin (for `--password-stdin`). */
  readStdin: () => Promise<string>
}

const HELP = `Usage: kervan-studio <command> [options]

Commands:
  start          Start Studio (the default)
  reset-admin    Set a new password for an admin, sign them out everywhere, and reactivate
                 them if they were deactivated
    --email <e>        Which admin (required when there are several)
    --password-stdin   Read the new password from stdin instead of generating one

Configuration (environment variables):
  KERVAN_STUDIO_PUBLIC_URL     The URL people use, e.g. https://studio.example.com
  KERVAN_STUDIO_HOST           Interface to listen on (default 127.0.0.1)
  KERVAN_STUDIO_PORT           Port (default 4310)
  KERVAN_STUDIO_DATA_DIR       Where the database lives (default ./.kervan-studio)
  KERVAN_STUDIO_TRUST_PROXY    Number of reverse proxies in front of Studio (default 0)
  KERVAN_STUDIO_DENY_NETWORK   Comma-separated addresses/CIDRs tools may never reach
  KERVAN_STUDIO_LOG_RETENTION_DAYS  Days to keep call logs (default 30)
  KERVAN_STUDIO_MASTER_KEY     Required: base64 of 32 random bytes; encrypts stored secrets
  KERVAN_STUDIO_PREVIOUS_MASTER_KEYS  Older keys (version:base64,...) while rotating
`

class UsageError extends Error {}

/** Runs the Studio command line; resolves with the exit code (`start` resolves once listening). */
export async function runStudioCli(argv: string[], io: StudioCliIo): Promise<number> {
  const [command = "start", ...rest] = argv
  try {
    if (command === "-h" || command === "--help" || command === "help") {
      io.out(HELP)
      return 0
    }
    if (command === "start") return await start(rest, io)
    if (command === "reset-admin") return await resetAdmin(rest, io)
    io.err(`Unknown command "${command}".\n\n${HELP}`)
    return 1
  } catch (error) {
    if (
      error instanceof UsageError ||
      error instanceof ConfigError ||
      error instanceof DatabaseError ||
      error instanceof KeyError ||
      error instanceof VaultError
    ) {
      io.err(`Error: ${error.message}`)
      return 1
    }
    throw error
  }
}

async function start(argv: string[], io: StudioCliIo): Promise<number> {
  parse(argv, {})
  const running = await startStudio(loadConfig(io.env, io.cwd), {
    print: io.err,
    keys: envKeyProvider(io.env),
  })
  const stop = () => {
    running.close().then(
      () => process.exit(0),
      () => process.exit(1),
    )
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  return 0
}

async function resetAdmin(argv: string[], io: StudioCliIo): Promise<number> {
  const { values } = parse(argv, {
    email: { type: "string" },
    "password-stdin": { type: "boolean" },
  })
  const config = loadConfig(io.env, io.cwd)
  const database = openDatabase(path.join(config.dataDir, DATABASE_FILE))
  try {
    const scope = defaultWorkspace(database.db)
    const admins = listAdmins(database.db, scope)
    const email = values.email as string | undefined
    const admin = email
      ? admins.find((user) => user.email === normalizeEmail(email))
      : admins.length === 1
        ? admins[0]
        : undefined
    if (!admin) {
      if (admins.length === 0) {
        throw new UsageError("There is no admin yet. Start Studio to get a setup token.")
      }
      throw new UsageError(
        email
          ? `No admin has the email ${email}.`
          : "There are several admins; choose one with --email.",
      )
    }

    const generated = values["password-stdin"] !== true
    const password = generated ? randomToken(18) : (await io.readStdin()).replace(/\r?\n$/, "")
    const problem = passwordProblem(password)
    if (problem) throw new UsageError(problem)
    const passwordHash = await hashPassword(password)
    const signedOut = writeTransaction(database.db, (tx) => {
      setPasswordHash(tx, scope, admin.id, passwordHash)
      // The operator's recovery path: a deactivated admin is reactivated.
      if (admin.disabledAt !== null) setDisabledAt(tx, scope, admin.id, null)
      const count = deleteSessionsOf(tx, scope, admin.id)
      recordAudit(
        tx,
        scope,
        { type: "cli" },
        {
          action: "user.password_reset",
          target: { type: "user", id: admin.id },
          details: {
            sessionsEnded: count,
            ...(admin.disabledAt !== null ? { reactivated: true } : {}),
          },
        },
      )
      return count
    })
    io.out(`Reset the password of ${admin.email}; ended ${signedOut} session(s).`)
    if (admin.disabledAt !== null) io.out(`${admin.email} was deactivated and is active again.`)
    if (generated) io.out(`New password (shown once): ${password}`)
    return 0
  } finally {
    database.close()
  }
}

type Options = Record<string, { type: "string" | "boolean" }>

function parse(argv: string[], options: Options) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: false, strict: true })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
}
