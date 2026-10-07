// Text that people type and other people see (names, emails, a failed login's email). Invisible
// characters in it can mislead: a right-to-left override turns "moc.elpmaxe@nimda" into what
// looks like an admin's address, a zero-width space makes two different names look the same, a
// line break fakes a second entry. Studio either refuses such text (fields people choose and can
// fix) or, when it must keep what was sent (a failed sign-in, for the record), shows each such
// character as a visible escape (a backslash, "u" and its code point): nothing is lost, and
// nothing is hidden on screen.
//
// No invisible or lookalike character is written literally in this file: they are code points.

/** Letters and symbols that draw as nothing: Hangul fillers, the braille blank, U+180E. */
const BLANK_LOOKING = [0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x180e]

/**
 * Characters that are invisible or change how the text around them is shown:
 * - C0 and C1 controls, including line breaks, tab and NUL (Cc), and the line and paragraph
 *   separators (Zl, Zp);
 * - format characters (Cf): bidi controls (U+200E/200F, U+202A-202E, U+2066-2069, U+061C),
 *   zero-width characters (U+200B-200D, U+2060, U+FEFF), the soft hyphen, tag characters, ...;
 * - the blank-looking letters above.
 */
const UNSAFE = new RegExp(
  `[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}${String.fromCodePoint(...BLANK_LOOKING)}]`,
  "u",
)

/** Whether the text holds a character `sanitizeDisplayText` would escape. */
export function hasUnsafeCharacters(text: string): boolean {
  return UNSAFE.test(text)
}

/** Why `text` is refused for `field`, or undefined when it is fine. */
export function unsafeTextProblem(text: string, field: string): string | undefined {
  const found = firstUnsafeCharacter(text)
  return found
    ? `${field} contains an invisible or control character (${found}). Remove it and try again.`
    : undefined
}

/** "U+202E" for the first unsafe character, for error messages. */
export function firstUnsafeCharacter(text: string): string | undefined {
  const found = UNSAFE.exec(text)?.[0]
  return found === undefined ? undefined : `U+${hex(found.codePointAt(0) ?? 0)}`
}

function hex(codePoint: number): string {
  return codePoint.toString(16).toUpperCase().padStart(4, "0")
}

/** A backslash, "u" and four hex digits (or the code point in braces, outside the BMP). */
function visibleEscape(character: string): string {
  const codePoint = character.codePointAt(0) ?? 0
  return codePoint > 0xffff ? `\\u{${hex(codePoint)}}` : `\\u${hex(codePoint)}`
}

/**
 * The text with every unsafe character replaced by its visible escape and every backslash
 * doubled (so typed text cannot pass for an escape), then cut to `maxLength` characters with "…"
 * when longer. The limit applies after escaping, and the cut never splits an escape or a
 * surrogate pair.
 */
export function sanitizeDisplayText(text: string, maxLength: number): string {
  const pieces: string[] = []
  for (const character of text) {
    pieces.push(
      character === "\\" ? "\\\\" : UNSAFE.test(character) ? visibleEscape(character) : character,
    )
  }
  const whole = pieces.join("")
  if (whole.length <= maxLength) return whole
  let cut = ""
  for (const piece of pieces) {
    if (cut.length + piece.length > maxLength - 1) break
    cut += piece
  }
  return `${cut}…`
}

/**
 * Lookalike letters, by code point, and the Latin letter they imitate: the common Cyrillic and
 * Greek ones, Turkish dotless i, and digits that pass for letters. Not exhaustive: it catches the
 * obvious impersonations.
 */
const CONFUSABLES = new Map<string, string>(
  (
    [
      // Cyrillic: a, ve, ie, io, ka, em, en, o, er, es, te, u, ha, dze, i, yi, je, komi de, palochka.
      [0x0430, "a"],
      [0x0432, "b"],
      [0x0435, "e"],
      [0x0451, "e"],
      [0x043a, "k"],
      [0x043c, "m"],
      [0x043d, "h"],
      [0x043e, "o"],
      [0x0440, "p"],
      [0x0441, "c"],
      [0x0442, "t"],
      [0x0443, "y"],
      [0x0445, "x"],
      [0x0455, "s"],
      [0x0456, "i"],
      [0x0457, "i"],
      [0x0458, "j"],
      [0x0501, "d"],
      [0x04cf, "i"],
      // Latin script g, Turkish dotless i.
      [0x0261, "g"],
      [0x0131, "i"],
      // Greek: alpha, beta, epsilon, eta, iota, kappa, nu, omicron, rho, tau, upsilon, chi, omega.
      [0x03b1, "a"],
      [0x03b2, "b"],
      [0x03b5, "e"],
      [0x03b7, "n"],
      [0x03b9, "i"],
      [0x03ba, "k"],
      [0x03bd, "v"],
      [0x03bf, "o"],
      [0x03c1, "p"],
      [0x03c4, "t"],
      [0x03c5, "u"],
      [0x03c7, "x"],
      [0x03c9, "w"],
      // Digits and strokes: zero reads as o; one, lower-case L and capital I as one stroke.
      [0x0030, "o"],
      [0x0031, "i"],
      [0x006c, "i"],
    ] as const
  ).map(([codePoint, latin]) => [String.fromCodePoint(codePoint), latin]),
)

/**
 * A comparison key for names that must not impersonate someone: compatibility forms and accents
 * removed, lower case, lookalikes folded, invisible characters and spaces removed. "Admin" in
 * upper case, full width, spaced out, with a digit one for the i, with a Cyrillic a or a Turkish
 * dotless i all give the key of "admin". Only for comparing, never for display.
 */
export function identitySkeleton(text: string): string {
  let folded = ""
  // NFKD splits accents off (a capital I with a dot becomes I plus a combining dot), and marks
  // are dropped.
  for (const character of text.normalize("NFKD").toLowerCase()) {
    if (UNSAFE.test(character) || /[\s\p{M}]/u.test(character)) continue
    folded += CONFUSABLES.get(character) ?? character
  }
  return folded
}

/** Labels a display name may not take: they look like Studio speaking, or like a role. */
export const RESERVED_NAMES = [
  "admin",
  "administrator",
  "root",
  "system",
  "owner",
  "support",
  "security",
  "moderator",
  "kervan",
  "kervan studio",
  "studio",
  "member",
  "you",
]
