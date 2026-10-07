// Spec text that people and models read: the server's name, version and description, tool titles
// and descriptions, and the titles and descriptions inside input and output schemas. Clients show
// it to people and hand it to the model as is, so a character that draws as nothing (or changes
// how the text around it is drawn, or drives a terminal) would let a spec say one thing to its
// reviewers and another to the model. Such characters are refused when the spec loads.
//
// No invisible character is written literally in this file: they are code points.

/** Letters and symbols that draw as nothing: Hangul fillers, the braille blank, U+180E. */
const BLANK_LOOKING = [0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x180e]

/**
 * Controls (Cc), format characters (Cf: bidi controls, zero-width characters, tag characters,
 * the soft hyphen, ...), line and paragraph separators, and the blank-looking letters above.
 */
const HIDDEN = new RegExp(
  `[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}${String.fromCodePoint(...BLANK_LOOKING)}]`,
  "u",
)

/**
 * Kept: zero-width non-joiner and joiner (Persian and Indic writing, emoji sequences need them),
 * and in multi-line text, line feed and tab.
 */
const ALWAYS_ALLOWED = new Set([0x200c, 0x200d])
const MULTILINE_ALLOWED = new Set([0x09, 0x0a])

/** "U+202E" for the first character `text` may not hold, or undefined. */
export function hiddenCharacter(text: string, multiline: boolean): string | undefined {
  for (const character of text) {
    if (!HIDDEN.test(character)) continue
    const codePoint = character.codePointAt(0) ?? 0
    if (ALWAYS_ALLOWED.has(codePoint) || (multiline && MULTILINE_ALLOWED.has(codePoint))) continue
    return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`
  }
  return undefined
}

/** The message for a refused character. */
export function hiddenCharacterMessage(found: string): string {
  return (
    `contains an invisible or control character (${found}): people reading the spec would not ` +
    "see what the model reads. Remove it."
  )
}

/**
 * The text with every such character (line breaks and tabs too) written as a visible escape, for
 * quoting spec text inside a message: a key cannot start a line of its own or hide the rest.
 */
/** A backslash and "u", as the escape starts. */
const BACKSLASH_U = String.fromCharCode(92, 117)

export function escapeHidden(text: string): string {
  let result = ""
  for (const character of text) {
    if (!HIDDEN.test(character)) {
      result += character
      continue
    }
    const codePoint = character.codePointAt(0) ?? 0
    const hex = codePoint.toString(16).toUpperCase().padStart(4, "0")
    result += codePoint > 0xffff ? `${BACKSLASH_U}{${hex}}` : `${BACKSLASH_U}${hex}`
  }
  return result
}
