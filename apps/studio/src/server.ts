import type { AddressInfo } from "node:net"
import path from "node:path"
import { serve } from "@hono/node-server"
import type { Logger } from "@kervan/core"
import { allowedHostNames, bindHost, ConfigError, type StudioConfig } from "./config.js"
import { type OpenedDatabase, openDatabase } from "./db/open.js"
import { issueSetupToken, SETUP_TOKEN_TTL_MS } from "./db/repos/tokens.js"
import { listAdmins } from "./db/repos/users.js"
import { defaultWorkspace } from "./db/repos/workspaces.js"
import { createStudioHttp } from "./http.js"
import { studioLogger } from "./logger.js"
import {
  addressRangeProblem,
  resolveSelfAddresses,
  type StudioNetworkOptions,
  studioNetworkPolicy,
} from "./network.js"
import { InMemorySecretStore, type SecretStore } from "./secrets.js"
import { Studio } from "./studio.js"

export const DATABASE_FILE = "studio.db"

export interface StartOptions {
  /** Where messages for the operator go (setup token, listening address). Default: stderr. */
  print?: (line: string) => void
  /** Default: an in-memory store (secrets do not survive a restart). */
  secrets?: SecretStore
  /** DNS and interface overrides for tests. There is no way to allow private addresses. */
  network?: Omit<StudioNetworkOptions, "denyList" | "selfAddresses">
  /** Resolves the public host name to Studio's own addresses. Default: DNS. */
  resolveSelf?: (host: string) => Promise<string[]>
  /** Where the built web UI is (tests). Default: `apps/studio/dist-web`. */
  webRoot?: string
}

export interface RunningStudio {
  studio: Studio
  url: URL
  /** The address actually bound (loopback until an admin exists). */
  boundHost: string
  /** Set when no admin exists yet: the single-use token that creates the first one. */
  setupToken: string | undefined
  database: OpenedDatabase
  close(): Promise<void>
}

/** Opens the database, builds Studio and starts listening. */
export async function startStudio(
  config: StudioConfig,
  options: StartOptions = {},
): Promise<RunningStudio> {
  const print = options.print ?? ((line: string) => process.stderr.write(`${line}\n`))
  // A bad entry would otherwise make every tool call fail with a masked internal error.
  for (const entry of config.denyNetwork) {
    const problem = addressRangeProblem(entry)
    if (problem) throw new ConfigError(`KERVAN_STUDIO_DENY_NETWORK: ${problem}`)
  }
  const database = openDatabase(path.join(config.dataDir, DATABASE_FILE))
  try {
    const scope = defaultWorkspace(database.db)
    const hasAdmin = listAdmins(database.db, scope).length > 0

    let selfAddresses: string[] = []
    try {
      selfAddresses = await resolveSelfAddresses(config.publicUrl.hostname, options.resolveSelf)
    } catch {
      print(
        `Warning: could not resolve ${config.publicUrl.hostname}; tools are still refused this ` +
          "machine's own addresses, but not the public URL's other addresses.",
      )
    }
    const network = studioNetworkPolicy({
      ...options.network,
      denyList: config.denyNetwork,
      selfAddresses,
    })

    let studio: Studio | undefined
    const logger: Logger = studioLogger((text) => studio?.gateway.redact(text) ?? text)
    studio = new Studio({
      db: database.db,
      secrets: options.secrets ?? new InMemorySecretStore(),
      network,
      allowedHosts: allowedHostNames(config),
      logger,
    })
    const servers: ReturnType<typeof serve>[] = []
    const listen = (hostname: string) =>
      new Promise<ReturnType<typeof serve>>((resolve, reject) => {
        const listening = serve({ fetch: http.fetch, port: config.port, hostname }, () => {
          listening.off("error", reject)
          servers.push(listening)
          resolve(listening)
        })
        listening.once("error", reject)
      })

    // Listeners that stopped accepting but may still finish requests (closed with the rest).
    const closing: ReturnType<typeof serve>[] = []
    /** Listens on `hostname`, retrying briefly while a just-closed listener frees the port. */
    const rebind = async (hostname: string): Promise<void> => {
      for (let attempt = 0; ; attempt++) {
        try {
          await listen(hostname)
          return
        } catch (error) {
          if ((error as { code?: string }).code !== "EADDRINUSE" || attempt >= 20) throw error
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
    }

    const host = bindHost(config, hasAdmin)
    const http = createStudioHttp(studio, config, {
      ...(options.webRoot ? { webRoot: options.webRoot } : {}),
      // Until now Studio listened on loopback only; with an admin it may serve its real host.
      onAdminCreated: () => {
        if (host === config.host) return
        // After the setup response is out: stop accepting on loopback (open connections finish),
        // then listen on the real host. Both may cover the same port (0.0.0.0 includes loopback).
        setTimeout(() => {
          for (const listening of servers.splice(0)) {
            listening.close()
            closing.push(listening)
          }
          void rebind(config.host).then(
            () => print(`The first admin exists: now listening on ${config.host}.`),
            async (error: unknown) => {
              // Never end up listening nowhere: go back to loopback and say so.
              print(
                `Could not listen on ${config.host} (${(error as Error).message}); still ` +
                  `listening on ${host}. Fix KERVAN_STUDIO_HOST and restart Studio.`,
              )
              await rebind(host).catch((fallback: unknown) =>
                print(`Could not listen on ${host} either: ${(fallback as Error).message}`),
              )
            },
          )
        }, 0)
      },
    })
    const server = await listen(host)
    const address = server.address() as AddressInfo
    const url = new URL(
      `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`,
    )

    let setupToken: string | undefined
    if (!hasAdmin) {
      setupToken = issueSetupToken(database.db).token
      if (host !== config.host) {
        print(`No admin yet: listening on ${host} only until the first admin is created.`)
      }
      print(
        `Create the first admin at ${config.publicUrl.origin}/setup with this one-time token ` +
          `(valid for ${SETUP_TOKEN_TTL_MS / 60_000} minutes; restart Studio for a new one):\n` +
          `  ${setupToken}`,
      )
    }
    print(`Kervan Studio listening on ${url.origin} (public URL ${config.publicUrl.origin})`)

    const running: RunningStudio = {
      studio,
      url,
      boundHost: host,
      setupToken,
      database,
      close: async () => {
        await studio.close()
        for (const listening of closing) {
          if ("closeAllConnections" in listening) listening.closeAllConnections()
        }
        await Promise.all(
          servers.map(
            (listening) =>
              new Promise<void>((done) => {
                listening.close(() => done())
                if ("closeAllConnections" in listening) listening.closeAllConnections()
              }),
          ),
        )
        database.close()
      },
    }
    return running
  } catch (error) {
    database.close()
    throw error
  }
}
