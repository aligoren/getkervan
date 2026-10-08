/** A terminal's input stream, as far as reading a hidden line needs it. */
export interface TerminalInput {
  setRawMode(mode: boolean): unknown
  resume(): unknown
  pause(): unknown
  /** Puts back what was read past the end of a line, for the next read. */
  unshift(chunk: Buffer): unknown
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown
  on(event: "end", listener: () => void): unknown
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown
  off(event: "end", listener: () => void): unknown
}

export class InputCancelled extends Error {
  override name = "InputCancelled"
}

/**
 * Reads one line from a terminal without showing it (a password). Enter ends it, Backspace
 * removes the last character, Ctrl+C cancels; other control characters and escape sequences
 * (arrow keys) are ignored. Nothing typed is ever written to `output`. What arrived after the
 * Enter (typed ahead, or pasted with the next line) is kept for the next read.
 *
 * The terminal itself echoes what is typed before this is called (before raw mode), as for any
 * password prompt.
 */
export function readHiddenLine(
  prompt: string,
  input: TerminalInput,
  output: { write(text: string): unknown },
): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = ""
    const finish = (error?: Error, rest?: string) => {
      input.off("data", onData)
      input.off("end", onEnd)
      input.setRawMode(false)
      input.pause()
      if (rest) input.unshift(Buffer.from(rest, "utf8"))
      output.write("\n")
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: Buffer | string) => {
      const chars = Array.from(typeof chunk === "string" ? chunk : chunk.toString("utf8"))
      for (let i = 0; i < chars.length; i++) {
        const char = chars[i] as string
        if (char === "\r" || char === "\n" || char === "\u0004") {
          const rest = chars.slice(i + 1)
          // "\r\n" is one Enter.
          if (char === "\r" && rest[0] === "\n") rest.shift()
          return finish(undefined, rest.join(""))
        }
        if (char === "\u0003") return finish(new InputCancelled("Cancelled."))
        // An escape sequence (arrow keys, function keys): the rest of this chunk belongs to it.
        if (char === "\u001b") return
        if (char === "\u007f" || char === "\b") {
          value = Array.from(value).slice(0, -1).join("")
          continue
        }
        if (char < " ") continue
        value += char
      }
    }
    const onEnd = () => finish()
    output.write(prompt)
    input.setRawMode(true)
    input.on("data", onData)
    input.on("end", onEnd)
    input.resume()
  })
}
