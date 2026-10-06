import type { App } from "@kervan/core"
import {
  Client,
  type Implementation,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client"
import { type AuthInfo, createMcpHandler } from "@modelcontextprotocol/server"

export interface TestClientOptions {
  /**
   * Protocol era to speak. `"modern"` (default) uses 2026-07-28 over an in-process HTTP exchange;
   * `"legacy"` uses the 2025 `initialize` handshake over an in-memory pair.
   */
  era?: "modern" | "legacy"
  clientInfo?: Implementation
  /** Auth info handed to tools as `ctx.auth` (modern era only). */
  authInfo?: AuthInfo
}

/**
 * Connects an official SDK `Client` to the app without opening a port or spawning a process.
 * Close it with `client.close()`.
 */
export async function createTestClient(app: App, options: TestClientOptions = {}): Promise<Client> {
  const info = options.clientInfo ?? { name: "kervan-test-client", version: "0.0.0" }

  if (options.era === "legacy") {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await app.createServer().connect(serverTransport)
    const client = new Client(info)
    await client.connect(clientTransport)
    return client
  }

  const handler = createMcpHandler(() => app.createServer())
  const authInfo = options.authInfo
  const transport = new StreamableHTTPClientTransport(new URL("http://kervan.test/mcp"), {
    fetch: (url, init) =>
      handler.fetch(new Request(url, init), authInfo === undefined ? undefined : { authInfo }),
  })
  const client = new Client(info, { versionNegotiation: { mode: { pin: "2026-07-28" } } })
  await client.connect(transport)
  const closeClient = client.close.bind(client)
  client.close = async () => {
    await closeClient()
    await handler.close()
  }
  return client
}
