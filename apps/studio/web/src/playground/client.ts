import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"

export type LogFn = (direction: "request" | "response", text: string) => void

/**
 * Connects a real MCP client to Studio's gateway with a playground token, logging the raw
 * traffic. The token itself is never logged.
 */
export async function connectPlayground(path: string, token: string, log: LogFn): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(path, window.location.origin), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: async (url, init) => {
      const body = typeof init?.body === "string" ? `\n${pretty(init.body)}` : ""
      log("request", `${init?.method ?? "GET"} ${String(url)}${body}`)
      const response = await fetch(url, init)
      // Streams (subscriptions) end later; log their text when they do.
      void response
        .clone()
        .text()
        .then(
          (text) => log("response", `${response.status} ${response.statusText}\n${pretty(text)}`),
          () => log("response", `${response.status} ${response.statusText} (stream closed)`),
        )
      return response
    },
  })
  const client = new Client(
    { name: "kervan-studio-playground", version: "0.1.0" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  )
  await client.connect(transport)
  return client
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
