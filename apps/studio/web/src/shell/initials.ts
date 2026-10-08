// The two letters in the user's avatar. Taken from the first letter or digit of each of the first
// two words of the display name (or of the email's local part): punctuation and symbols are
// skipped ("Deniz (ops)" is "DO", not "D("), and a letter is a whole grapheme, so an accent or a
// combining mark stays with its letter.

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** The first grapheme of `word` that contains a letter or a digit, upper-cased; or "". */
function firstLetter(word: string): string {
  for (const { segment } of segmenter.segment(word)) {
    if (LETTER_OR_DIGIT.test(segment)) return segment.toUpperCase()
  }
  return ""
}

function fromWords(text: string): string {
  const letters = text
    .split(/[\s@._+-]+/u)
    .map(firstLetter)
    .filter(Boolean)
  return letters.slice(0, 2).join("")
}

export function initials(user: { displayName?: string | null; email: string }): string {
  const name = user.displayName?.trim()
  return (name ? fromWords(name) : "") || fromWords(user.email.split("@")[0] ?? "") || "?"
}
