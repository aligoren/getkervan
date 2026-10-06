import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import type { App, Logger } from "../src/index.js"

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error"
  message: string
  data: unknown
}

export function recordingLogger(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = []
  const record = (level: LogEntry["level"]) => (message: string, data?: unknown) => {
    entries.push({ level, message, data })
  }
  return {
    entries,
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
  }
}

/** Connects a real SDK client to the app over an in-memory pair (2025-era handshake). */
export async function connect(app: App): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await app.createServer().connect(serverTransport)
  const client = new Client({ name: "kervan-core-test", version: "0.0.0" })
  await client.connect(clientTransport)
  return client
}

export function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text?: string }[]
  return content.map((block) => block.text ?? "").join("")
}
