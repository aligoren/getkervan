// Date-dependent checks of the website, kept out of `pnpm test` so that the test suite does not turn
// red on its own as time passes. Run before deploying (and, once the repository is published, on a
// schedule in CI): `pnpm check:site`.
//
// - security.txt: an error once Expires has passed, a warning when it is less than 30 days away or
//   more than a year ahead (RFC 9116 recommends less than a year).
// - site/schema/v1.json: an error when it differs from the package's schema (`pnpm site:schema`).
//
// `--strict` (the weekly CI job) fails on warnings too, so an expiry coming up is not missed.
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const DAY = 86_400_000

/** The fields of a security.txt (`Name: value` lines; comments and blank lines skipped). */
export function securityTxtFields(text) {
  return new Map(
    text
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "" && !line.startsWith("#"))
      .map((line) => {
        const at = line.indexOf(": ")
        return [line.slice(0, at), line.slice(at + 2)]
      }),
  )
}

/** Checks security.txt's Expires against `now`. */
export function checkSecurityTxt(text, now = Date.now()) {
  const errors = []
  const warnings = []
  const expires = Date.parse(securityTxtFields(text).get("Expires") ?? "")
  if (Number.isNaN(expires)) {
    errors.push("security.txt has no valid Expires date.")
  } else if (expires <= now) {
    errors.push(
      `security.txt expired on ${new Date(expires).toISOString()}: set a new Expires date (at most a year ahead) and redeploy.`,
    )
  } else if (expires - now < 30 * DAY) {
    const days = Math.ceil((expires - now) / DAY)
    warnings.push(`security.txt expires in ${days} day(s): renew Expires soon.`)
  } else if (expires - now > 366 * DAY) {
    warnings.push("security.txt expires more than a year ahead; RFC 9116 recommends less.")
  }
  return { errors, warnings }
}

/** The exit code: 1 on errors, and with `strict` on warnings too. */
export function exitCode({ errors, warnings }, strict) {
  return errors.length > 0 || (strict && warnings.length > 0) ? 1 : 0
}

function main() {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8")
  const { errors, warnings } = checkSecurityTxt(read("site/.well-known/security.txt"))
  if (read("site/schema/v1.json") !== read("packages/spec-runtime/schema/kervan.schema.json")) {
    errors.push("site/schema/v1.json differs from the package's schema: run `pnpm site:schema`.")
  }
  for (const warning of warnings) console.warn(`warning: ${warning}`)
  for (const error of errors) console.error(`error: ${error}`)
  if (exitCode({ errors, warnings }, process.argv.includes("--strict")) !== 0) process.exit(1)
  console.log(warnings.length > 0 ? "check:site passed with warnings." : "check:site passed.")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
