import path from "node:path"
import { parseArgs } from "node:util"
import { checkEmail, createFirstAdmin } from "./accounts.js"
import { ConfigError, loadConfig } from "./config.js"
import { hashPassword, passwordProblem, randomToken } from "./crypto.js"
import { DatabaseError, openDatabase, storedSecretCount, writeTransaction } from "./db/open.js"
import { recordAudit } from "./db/repos/audit.js"
import {
  anyAdminExists,
  deleteSessionsOf,
  listAdmins,
  normalizeEmail,
  setDisabledAt,
  setPasswordHash,
} from "./db/repos/users.js"
import { defaultWorkspace } from "./db/repos/workspaces.js"
import { envKeyProvider, KeyError } from "./keys.js"
import { nodeVersionProblem } from "./node-version.js"
import { DATABASE_FILE, startStudio } from "./server.js"
import { StudioError } from "./studio.js"
import { InputCancelled, readHiddenLine } from "./tty.js"
import { DbSecretStore, VaultError } from "./vault.js"

export interface StudioCliIo {
  out: (line: string) => void
  err: (line: string) => void
  env: NodeJS.ProcessEnv
  cwd: string
  /** Reads all of stdin (for `--password-stdin`). */
  readStdin: () => Promise<string>
  /**
   * Reads a line typed in the terminal without showing it (a password). Left out: the process's
   * own terminal, when stdin is one. `undefined`: there is no terminal.
   */
  readSecret?: ((prompt: string) => Promise<string>) | undefined
  /** The Node.js version to check (tests). Default: this process's. */
  nodeVersion?: string
}

const HELP = `Usage: kervan-studio <command> [options]

Commands:
  start          Start Studio (the default)
  create-admin   Create the first admin from this shell (no setup token; refused once an admin
                 exists). The password is typed hidden, or read from stdin; never an argument.
    --email <e>        The admin's email (required)
    --password-stdin   Read the password from stdin instead of asking for it
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
    const unsupported = nodeVersionProblem(io.nodeVersion ?? process.versions.node)
    if (unsupported) throw new UsageError(unsupported)
    if (command === "start") return await start(rest, io)
    if (command === "create-admin") return await createAdmin(rest, io)
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
    const busy = portInUseMessage(error)
    if (busy) {
      io.err(`Error: ${busy}`)
      return 1
    }
    throw error
  }
}

/** One line instead of Node's stack trace when Studio's port is taken. */
function portInUseMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const { code, port, address } = error as { code?: unknown; port?: unknown; address?: unknown }
  if (code !== "EADDRINUSE") return undefined
  return (
    `Port ${typeof port === "number" ? port : "?"}${typeof address === "string" ? ` on ${address}` : ""} ` +
    "is already in use. Stop the program using it, or set KERVAN_STUDIO_PORT to another port."
  )
}

async function start(argv: string[], io: StudioCliIo): Promise<number> {
  parse(argv, {})
  const config = loadConfig(io.env, io.cwd)
  const running = await startStudio(config, {
    print: io.err,
    keys: masterKeys(io.env, config.dataDir),
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

/**
 * The master keys, or an error that fits the data directory: when it already holds encrypted
 * secrets, a new key is the wrong answer (they could not be read with it), so say so.
 */
function masterKeys(env: NodeJS.ProcessEnv, dataDir: string) {
  try {
    return envKeyProvider(env)
  } catch (error) {
    if (!(error instanceof KeyError) || env.KERVAN_STUDIO_MASTER_KEY?.trim()) throw error
    const stored = storedSecretCount(path.join(dataDir, DATABASE_FILE))
    if (stored === 0) throw error
    throw new KeyError(
      `KERVAN_STUDIO_MASTER_KEY is not set. This data directory (${dataDir}) already holds ` +
        `${stored} encrypted secret${stored === 1 ? "" : "s"}, made with the master key it was ` +
        "set up with: set that key. Do not create a new one: Studio could not decrypt the stored " +
        "secrets with it.",
    )
  }
}

const PASSWORD_ARGUMENT =
  "create-admin does not take the password as an argument (it would be kept in shell history " +
  "and shown in the process list). Type it when asked, or pipe it with --password-stdin."

const ADMIN_EXISTS =
  "Studio already has an admin; create-admin only creates the first one. Admins add users in " +
  "Studio (Users); to recover an admin account, use kervan-studio reset-admin."

/**
 * Creates the first admin without the browser (a container, where the loopback-only setup page
 * cannot be reached). Resolves the data directory and the master key like `start`, so a missing
 * or wrong key is reported here too. A running Studio is not needed; one that is running sees
 * the new admin within a few seconds and starts listening on its configured host.
 */
async function createAdmin(argv: string[], io: StudioCliIo): Promise<number> {
  if (argv.some((arg) => /^--password(=|$)/.test(arg))) throw new UsageError(PASSWORD_ARGUMENT)
  const { values } = parse(argv, {
    email: { type: "string" },
    "password-stdin": { type: "boolean" },
  })
  const email = values.email as string | undefined
  if (!email) {
    throw new UsageError("Give the admin's email: kervan-studio create-admin --email <email>")
  }
  const config = loadConfig(io.env, io.cwd)
  const keys = masterKeys(io.env, config.dataDir)
  const database = openDatabase(path.join(config.dataDir, DATABASE_FILE))
  try {
    // Every stored secret must decrypt with the key, as at a start (nothing is re-encrypted here).
    new DbSecretStore(database.db, keys).verifyAndRewrap(Date.now(), { rewrap: false })
    // Before asking for a password nobody needs (both checked again when writing). The email is
    // shown in the prompt, so it must be one people can see as it is.
    if (anyAdminExists(database.db)) throw new UsageError(ADMIN_EXISTS)
    checkEmail(email)
    const password = await newPassword(email, values["password-stdin"] === true, io)
    const { user, setupTokensRetired } = await createFirstAdmin(database.db, { email, password })
    io.out(`Created the admin ${user.email}. Sign in at ${config.publicUrl.origin}.`)
    if (setupTokensRetired > 0) io.out("The setup token Studio printed no longer works.")
    io.out(
      "A running Studio starts listening on KERVAN_STUDIO_HOST within a few seconds; " +
        "otherwise start it now.",
    )
    return 0
  } catch (error) {
    if (error instanceof StudioError) {
      throw new UsageError(
        error.message === "Studio is already set up." ? ADMIN_EXISTS : error.message,
      )
    }
    throw error
  } finally {
    database.close()
  }
}

/** The new admin's password: from stdin, or typed twice in the terminal, never shown. */
async function newPassword(email: string, fromStdin: boolean, io: StudioCliIo): Promise<string> {
  if (fromStdin) return (await io.readStdin()).replace(/\r?\n$/, "")
  const ask = "readSecret" in io ? io.readSecret : terminalReader()
  if (!ask) {
    throw new UsageError(
      "No terminal to type the password in. Run with a terminal (docker exec -it ...), or pipe " +
        "the password with --password-stdin.",
    )
  }
  try {
    const password = await ask(`Password for ${email}: `)
    const problem = passwordProblem(password)
    if (problem) throw new UsageError(problem)
    if ((await ask("Type it again: ")) !== password) {
      throw new UsageError("The passwords do not match; nothing was changed.")
    }
    return password
  } catch (error) {
    if (error instanceof InputCancelled) throw new UsageError("Cancelled; nothing was changed.")
    throw error
  }
}

/** Reads hidden input from this process's terminal, when stdin is one. */
function terminalReader(): ((prompt: string) => Promise<string>) | undefined {
  const stdin = process.stdin
  if (!stdin.isTTY) return undefined
  return (prompt) => readHiddenLine(prompt, stdin, process.stderr)
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
