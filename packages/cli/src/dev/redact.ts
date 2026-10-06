/** Environment variable names whose values are treated as secrets. */
const SECRET_NAME =
  /SECRET|TOKEN|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL|AUTH|COOKIE|SESSION|DSN|DATABASE_URL|CONNECTION_STRING|(^|_)KEY$/i

/** Values shorter than this are not redacted: they would match too much ordinary text. */
const MIN_SECRET_LENGTH = 6

export const REDACTED = "[redacted]"

/** Secret-looking values from an environment, longest first. */
export function collectSecrets(env: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>()
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= MIN_SECRET_LENGTH && SECRET_NAME.test(name)) values.add(value)
  }
  return [...values].sort((a, b) => b.length - a.length)
}

export type Redactor = (text: string) => string

/**
 * Replaces known secret values and credentials embedded in URLs (`scheme://user:pass@host`).
 * Applied to everything `kervan dev` prints that comes from the server or a tool call.
 */
export function createRedactor(secrets: readonly string[]): Redactor {
  return (text) => {
    let result = text
    for (const secret of secrets) result = result.split(secret).join(REDACTED)
    return result.replace(
      /(\b[a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi,
      `$1$2:${REDACTED}@`,
    )
  }
}
