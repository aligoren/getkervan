import { createInterface } from "node:readline"
import type { App } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"
import type { CallToolResult } from "@modelcontextprotocol/client"
import { terminalSafe } from "../terminal.js"
import type { Redactor } from "./redact.js"

export interface ReplOptions {
  app: App
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  redact: Redactor
  reload: () => Promise<unknown>
  /** Called once, on `exit` or end of input. */
  onExit: () => void
}

const HELP = `Commands:
  tools                 List the tools
  call <tool> [json]    Call a tool, e.g. call greet {"name":"Ada"}
  reload                Restart the server
  help                  Show this help
  exit                  Stop the dev server`

/**
 * A line-based inspector in the dev terminal. It calls tools through the same app that serves
 * clients, so validation, middleware and error masking behave exactly as for a real client.
 */
export async function startRepl(options: ReplOptions): Promise<{ close(): Promise<void> }> {
  // Tool results are upstream data: no control sequence reaches the terminal (terminal.ts).
  const print = (line: string) => options.output.write(`${terminalSafe(options.redact(line))}\n`)
  const client = await createTestClient(options.app, {
    clientInfo: { name: "kervan-dev-repl", version: "0.0.0" },
  })
  let exited = false
  // Piped input can end while earlier lines are still running; never prompt after that.
  let inputClosed = false
  // Prompts only make sense in a terminal; piped input gets plain output lines.
  const interactive = (options.output as { isTTY?: boolean }).isTTY === true
  const rl = createInterface({
    input: options.input,
    output: options.output,
    prompt: "kervan> ",
    terminal: interactive,
  })
  const prompt = () => {
    if (interactive && !exited && !inputClosed) rl.prompt()
  }

  const exit = () => {
    if (exited) return
    exited = true
    if (!inputClosed) rl.close()
    options.onExit()
  }

  const handle = async (line: string) => {
    const trimmed = line.trim()
    const space = trimmed.indexOf(" ")
    const command = space === -1 ? trimmed : trimmed.slice(0, space)
    const rest = space === -1 ? "" : trimmed.slice(space + 1).trim()
    switch (command) {
      case "":
        return
      case "help":
        return print(HELP)
      case "exit":
      case "quit":
        return exit()
      case "reload":
        await options.reload()
        return
      case "tools": {
        const { tools } = await client.listTools()
        if (tools.length === 0) return print("(no tools)")
        for (const tool of tools) print(`  ${tool.name}  ${tool.description ?? ""}`)
        return
      }
      case "call": {
        const nameEnd = rest.indexOf(" ")
        const name = nameEnd === -1 ? rest : rest.slice(0, nameEnd)
        const json = nameEnd === -1 ? "{}" : rest.slice(nameEnd + 1)
        if (!name) return print('Usage: call <tool> [json], e.g. call greet {"name":"Ada"}')
        let args: unknown
        try {
          args = JSON.parse(json)
        } catch {
          return print(`Arguments must be JSON, got: ${json}`)
        }
        const result = (await client.callTool(
          { name, arguments: args as Record<string, unknown> },
          {
            onprogress: (p) =>
              print(
                `  progress ${p.progress}${p.total === undefined ? "" : `/${p.total}`} ${p.message ?? ""}`,
              ),
          },
        )) as CallToolResult
        return printResult(result, print)
      }
      default:
        return print(`Unknown command "${command}". Type "help".`)
    }
  }

  // Lines run one after another, so piped input behaves like typed input.
  let queue = Promise.resolve()
  rl.on("line", (line) => {
    queue = queue
      .then(() => handle(line))
      .catch((error: unknown) => print(`Error: ${(error as Error).message}`))
      .then(prompt)
  })
  rl.on("close", () => {
    inputClosed = true
    queue.then(exit, exit)
  })
  print('Type "help" for commands.')
  prompt()

  return {
    close: async () => {
      exited = true
      if (!inputClosed) rl.close()
      await client.close()
    },
  }
}

function printResult(result: CallToolResult, print: (line: string) => void) {
  const prefix = result.isError ? "error: " : ""
  for (const block of result.content) {
    print(block.type === "text" ? `${prefix}${block.text}` : `${prefix}[${block.type} content]`)
  }
  if (result.structuredContent !== undefined) {
    print(`structured: ${JSON.stringify(result.structuredContent)}`)
  }
}
