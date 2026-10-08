// What must never appear in a screenshot of the website: a real API key or playground token,
// the setup token or master key of the Studio being photographed, this machine's name, user name,
// home or temporary folder, a real email address, a non-documentation IP address.
// `pnpm site:screenshots` runs `findLeaks` on every page's text before each capture and refuses
// to capture when anything is found. Tested in scripts/test/site-leaks.test.ts.
import os from "node:os"

/** Email domains reserved for examples (RFC 2606/6761) and the project's own. */
const SAFE_EMAIL_DOMAINS =
  /@(?:[a-z0-9-]+\.)*(?:example\.(?:test|com|org|net)|example|test|invalid|getkervan\.dev)$/i

/** Loopback and the documentation ranges (RFC 5737): what demo data may show. */
function safeIPv4(ip) {
  return (
    ip.startsWith("127.") ||
    ip.startsWith("192.0.2.") ||
    ip.startsWith("198.51.100.") ||
    ip.startsWith("203.0.113.") ||
    ip === "0.0.0.0"
  )
}

/** Values of the run that must not show (setup token, master key, ...), and machine facts. */
export function machineSecrets(extra = []) {
  const user = (() => {
    try {
      return os.userInfo().username
    } catch {
      return ""
    }
  })()
  return [
    ...extra,
    os.hostname(),
    os.homedir(),
    os.tmpdir(),
    // Shorter than this, a value would match ordinary words.
    user.length >= 4 ? user : "",
  ].filter((value) => typeof value === "string" && value.length >= 4)
}

/**
 * The leaks in `text`, as short descriptions (never the value itself). `secrets` are exact values
 * that must not appear (compared case-insensitively, and with either kind of path separator).
 */
export function findLeaks(text, secrets = []) {
  const found = []
  // API keys and playground tokens as Studio makes them (kvn_ + 43 base64url characters).
  if (/kvn_[A-Za-z0-9_-]{40,}/.test(text)) found.push("an API key (kvn_...)")
  if (/kvp_[A-Za-z0-9_-]{20,}/.test(text)) found.push("a playground token (kvp_...)")
  // Common credential shapes of other services.
  if (/\b(?:ghp|gho|ghs|github_pat)_[A-Za-z0-9_]{20,}/.test(text)) found.push("a GitHub token")
  if (/\bsk-[A-Za-z0-9_-]{20,}/.test(text)) found.push("an sk- key")
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) found.push("an AWS access key")
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) found.push("a private key")
  for (const match of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    if (!SAFE_EMAIL_DOMAINS.test(match[0])) found.push(`an email address outside example domains`)
  }
  for (const match of text.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
    const octets = match.slice(1, 5).map(Number)
    // A product version ("Chrome/141.0.0.0" in a user agent) is not an address; "http://10.0.0.5" is.
    const before = text.slice(Math.max(0, (match.index ?? 0) - 24), match.index)
    const version = /[A-Za-z][A-Za-z0-9]*\/$/.test(before) && !/:\/\/$/.test(before)
    if (octets.every((octet) => octet <= 255) && !version && !safeIPv4(match[0])) {
      found.push("an IP address outside loopback and documentation ranges")
    }
  }
  if (
    /\b[A-Za-z]:\\(?:Users|Documents and Settings)\\/i.test(text) ||
    /\/(?:home|Users)\/[^/\s]+/.test(text)
  ) {
    found.push("a home folder path")
  }
  const lower = text.toLowerCase()
  const lowerSlashed = lower.replaceAll("\\", "/")
  for (const secret of secrets) {
    const value = String(secret).toLowerCase()
    if (lower.includes(value) || lowerSlashed.includes(value.replaceAll("\\", "/"))) {
      found.push("a value of this run or machine (token, key, host name, user or folder)")
    }
  }
  return [...new Set(found)]
}

/** Throws when `text` (a page about to be captured) leaks anything. */
export function assertNoLeaks(text, secrets, what) {
  const leaks = findLeaks(text, secrets)
  if (leaks.length > 0) {
    throw new Error(`Refusing to capture ${what}: it shows ${leaks.join("; ")}.`)
  }
}
