/** The rule the API enforces: 1-64 of a-z, 0-9 and -, starting and ending with a letter or digit. */
export const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

// Turkish dotless and dotted I do not decompose to "i"; combining marks are U+0300 to U+036F.
const TURKISH_I = /[\u0131\u0130]/g
const COMBINING_MARKS = /[\u0300-\u036f]/g

/**
 * A slug suggested from a server's name: "Hava Durumu (İstanbul)" → "hava-durumu-istanbul".
 * Accents are dropped, anything else becomes a dash, and the result fits the API's rule (or is
 * empty when the name has no letters or digits).
 */
export function slugify(name: string): string {
  return name
    .replace(TURKISH_I, "i")
    .normalize("NFKD")
    .replace(COMBINING_MARKS, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "")
}
