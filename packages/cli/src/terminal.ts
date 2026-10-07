// What the CLI writes to a terminal can hold text it did not write: a spec's field names, a tool's
// description, a tool result (upstream data), a server's own stderr. A terminal acts on control
// characters: ESC starts sequences that retitle the window, move the cursor, erase or hide lines,
// write the clipboard (OSC 52) or make links whose text lies (OSC 8); a carriage return lets the
// rest of a line overwrite its start. So every line goes through `terminalSafe` on its way out.

/** A backslash and "u", as an escape starts. */
const BACKSLASH_U = String.fromCharCode(92, 117)

/**
 * Controls (Cc), format characters (Cf: bidi controls, zero-width and tag characters, ...) and the
 * line and paragraph separators.
 */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u

/** Kept as they are: line feed and tab (lines and columns the CLI prints), ZWNJ and ZWJ (text). */
const KEPT = new Set([0x0a, 0x09, 0x200c, 0x200d])

/** The text with every other control or format character written as a visible escape. */
export function terminalSafe(text: string): string {
  let result = ""
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0
    if (!HIDDEN.test(character) || KEPT.has(codePoint)) {
      result += character
      continue
    }
    const hex = codePoint.toString(16).toUpperCase().padStart(4, "0")
    result += codePoint > 0xffff ? `${BACKSLASH_U}{${hex}}` : `${BACKSLASH_U}${hex}`
  }
  return result
}
