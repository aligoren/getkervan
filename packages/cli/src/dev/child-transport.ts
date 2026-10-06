import type { ChildProcessWithoutNullStreams } from "node:child_process"
import {
  type JSONRPCMessage,
  ReadBuffer,
  serializeMessage,
  type Transport,
} from "@modelcontextprotocol/client"

/**
 * MCP over the stdin/stdout of a process we spawned ourselves. Unlike the SDK's stdio client
 * transport, `close()` only ends stdin: stopping the process (gracefully or by force) is the
 * caller's job, so it can work the same way on Windows, where signals cannot ask a process to
 * shut down cleanly.
 */
export class ChildProcessTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void

  readonly #child: ChildProcessWithoutNullStreams
  readonly #buffer = new ReadBuffer()
  #closed = false

  constructor(child: ChildProcessWithoutNullStreams) {
    this.#child = child
  }

  async start(): Promise<void> {
    this.#child.stdout.on("data", (chunk: Buffer) => {
      this.#buffer.append(chunk)
      for (;;) {
        let message: JSONRPCMessage | null
        try {
          message = this.#buffer.readMessage()
        } catch (error) {
          this.onerror?.(
            new Error(
              "The server wrote a line to stdout that is not JSON-RPC. Log to stderr instead " +
                "(console.error); stdout carries the MCP connection.",
              { cause: error },
            ),
          )
          continue
        }
        if (message === null) break
        this.onmessage?.(message)
      }
    })
    this.#child.stdout.once("close", () => this.#markClosed())
    this.#child.stdin.on("error", (error) => {
      // Writing to a process that already exited; reported through close instead.
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") this.onerror?.(error)
    })
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("The server process is not connected."))
    return new Promise((resolve) => {
      if (this.#child.stdin.write(serializeMessage(message))) resolve()
      else this.#child.stdin.once("drain", resolve)
    })
  }

  /** Ends stdin, which tells a stdio MCP server to shut down. Does not wait for the process. */
  async close(): Promise<void> {
    if (!this.#child.stdin.writableEnded) this.#child.stdin.end()
    this.#markClosed()
  }

  #markClosed(): void {
    if (this.#closed) return
    this.#closed = true
    this.#buffer.clear()
    this.onclose?.()
  }
}
