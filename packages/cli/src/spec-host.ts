import { readFile } from "node:fs/promises"
import path from "node:path"
import { inspect, parseEnv } from "node:util"
import { type App, createApp, type Logger } from "@kervan/core"
import {
  applySpec,
  envSecrets,
  formatIssue,
  loadSpec,
  type NetworkPolicy,
  SecretVault,
  SpecLoadError,
} from "@kervan/spec-runtime"
import { collectSecrets, createRedactor, type Redactor } from "./dev/redact.js"

/** Every address, for `--allow-private-network` (development only). */
export const ALLOW_ALL_NETWORKS = ["0.0.0.0/0", "::/0"]

/** Printed on every start with `--allow-insecure-secrets`: hard to miss in a terminal or log. */
export const INSECURE_SECRETS_WARNING = [
  "!".repeat(72),
  "!! WARNING: --allow-insecure-secrets is on.",
  "!! Spec tools may send secrets over plain http, unencrypted, readable on the network.",
  "!! Use it only against a local development API, never in production.",
  "!".repeat(72),
].join("\n")

/** The SSRF policy for `--allow-private-network` and `--deny-network`. */
export function cliNetworkPolicy(options: {
  allowPrivateNetwork: boolean
  denyNetwork: readonly string[]
}): NetworkPolicy | undefined {
  if (!options.allowPrivateNetwork && options.denyNetwork.length === 0) return undefined
  return {
    ...(options.allowPrivateNetwork ? { allowPrivate: ALLOW_ALL_NETWORKS } : {}),
    ...(options.denyNetwork.length > 0 ? { denyList: options.denyNetwork } : {}),
  }
}

export interface SpecHostOptions {
  file: string
  env: NodeJS.ProcessEnv
  network?: NetworkPolicy
  /** Let tools that use secrets call plain http URLs (`--allow-insecure-secrets`). */
  allowSecretsOverHttp?: boolean
  /** Where messages go (already redacted). */
  print: (line: string) => void
}

/**
 * Serves a kervan.yaml spec from one app and reloads it in place. A reload that fails keeps the
 * last good version; tools whose spec did not change keep their registry entry.
 */
export class SpecHost {
  readonly app: App
  readonly #options: SpecHostOptions
  readonly #vault: SecretVault
  readonly #redact: Redactor
  #signatures = new Map<string, string>()
  #loaded = false

  private constructor(options: SpecHostOptions, app: App, vault: SecretVault, redact: Redactor) {
    this.#options = options
    this.app = app
    // The same vault across reloads keeps every secret value seen so far redacted.
    this.#vault = vault
    this.#redact = redact
  }

  /** Loads the spec once. Throws `SpecLoadError` if the first load fails. */
  static async start(options: SpecHostOptions): Promise<SpecHost> {
    const envRedact = createRedactor(collectSecrets(options.env))
    const vault = new SecretVault()
    const redact: Redactor = (text) => envRedact(vault.redact(text))
    const first = await loadSpec(await readFile(options.file, "utf8"), {
      fileName: path.basename(options.file),
      secrets: envSecrets(options.env),
      vault,
      ...(options.network ? { network: options.network } : {}),
      allowSecretsOverHttp: options.allowSecretsOverHttp === true,
    })
    const app = createApp({
      name: first.spec.name,
      version: first.spec.version,
      ...(first.spec.description ? { instructions: first.spec.description } : {}),
      logger: redactingLogger(redact, options.print),
    })
    const host = new SpecHost(options, app, vault, redact)
    host.#signatures = applySpec(app.registry, first)
    host.#loaded = true
    host.#warn(first.warnings, path.basename(options.file))
    host.#print(`Loaded ${first.spec.name} ${first.spec.version}: ${first.tools.length} tool(s)`)
    return host
  }

  /** Reloads the spec file; returns false (and keeps serving) if it is invalid. */
  async reload(reason: string): Promise<boolean> {
    const fileName = path.basename(this.#options.file)
    try {
      const next = await loadSpec(await readFile(this.#options.file, "utf8"), {
        fileName,
        secrets: envSecrets(this.#options.env),
        vault: this.#vault,
        ...(this.#options.network ? { network: this.#options.network } : {}),
        allowSecretsOverHttp: this.#options.allowSecretsOverHttp === true,
      })
      this.#signatures = applySpec(this.app.registry, next, this.#signatures)
      this.#warn(next.warnings, fileName)
      this.#print(`Reloaded (${reason}): ${next.tools.length} tool(s)`)
      return true
    } catch (error) {
      const message = error instanceof SpecLoadError ? error.message : (error as Error).message
      this.#print(`Could not reload (${reason}); still serving the previous version.\n${message}`)
      return false
    }
  }

  get loaded(): boolean {
    return this.#loaded
  }

  /** Redacts secret values from text (spec secrets and secret-looking environment variables). */
  get redact(): Redactor {
    return this.#redact
  }

  async close(): Promise<void> {}

  #warn(warnings: Parameters<typeof formatIssue>[1][], fileName: string): void {
    for (const warning of warnings) this.#print(`Warning: ${formatIssue(fileName, warning)}`)
  }

  #print(line: string): void {
    this.#options.print(this.#redact(line))
  }
}

/** Reads `--env-file` files. Like Node's own flag, variables already set are not overridden. */
export async function loadEnvFiles(
  files: readonly string[],
  base: NodeJS.ProcessEnv,
  cwd: string,
): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {}
  for (const file of files) {
    const content = await readFile(path.resolve(cwd, file), "utf8").catch(() => {
      throw new Error(`Env file not found: ${file}`)
    })
    Object.assign(env, parseEnv(content))
  }
  return { ...env, ...base }
}

function redactingLogger(redact: Redactor, print: (line: string) => void): Logger {
  const write = (level: string) => (message: string, data?: unknown) => {
    const detail =
      data === undefined ? "" : ` ${inspect(data, { depth: 4, breakLength: Infinity })}`
    print(redact(`[kervan] ${level}: ${message}${detail}`))
  }
  return { debug: () => {}, info: write("info"), warn: write("warn"), error: write("error") }
}
