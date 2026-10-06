import type { App, ToolRegistry } from "@kervan/core"
import {
  Client,
  type ClientOptions,
  type Implementation,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import type { AuthInfo } from "@modelcontextprotocol/server"
import { createRegistryHandler } from "./registry-handler.js"

export interface TestClientOptions {
  /**
   * Protocol era to speak. `"modern"` (default) uses 2026-07-28 over an in-process HTTP exchange;
   * `"legacy"` uses the 2025 `initialize` handshake over an in-memory pair.
   */
  era?: "modern" | "legacy"
  clientInfo?: Implementation
  /** Extra SDK client options, e.g. `listChanged` to follow tool list changes. */
  client?: Omit<ClientOptions, "versionNegotiation">
  /** Tool set to serve. Default: the app's registry. */
  registry?: ToolRegistry
  /** Auth info handed to tools as `ctx.auth` (modern era only). */
  authInfo?: AuthInfo
}

/**
 * Connects an official SDK `Client` to the app without opening a port or spawning a process.
 * Registry changes reach the client as `list_changed` in both eras. Close it with `client.close()`.
 */
export async function createTestClient(app: App, options: TestClientOptions = {}): Promise<Client> {
  const info = options.clientInfo ?? { name: "kervan-test-client", version: "0.0.0" }
  const registry = options.registry ?? app.registry

  if (options.era === "legacy") {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const live = app.createLiveServer(registry)
    await live.server.connect(serverTransport)
    const client = new Client(info, options.client)
    await client.connect(clientTransport)
    return withCleanup(client, async () => {
      live.dispose()
      await live.server.close()
    })
  }

  const { handler, dispose } = createRegistryHandler(app, registry)
  const authInfo = options.authInfo
  const transport = new StreamableHTTPClientTransport(new URL("http://kervan.test/mcp"), {
    fetch: (url, init) =>
      handler.fetch(new Request(url, init), authInfo === undefined ? undefined : { authInfo }),
  })
  const client = new Client(info, {
    ...options.client,
    versionNegotiation: { mode: { pin: "2026-07-28" } },
  })
  await client.connect(transport)
  return withCleanup(client, dispose)
}

function withCleanup(client: Client, cleanup: () => Promise<void>): Client {
  const close = client.close.bind(client)
  client.close = async () => {
    await close()
    await cleanup()
  }
  return client
}
