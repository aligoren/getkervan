// The `claude mcp add` commands the key dialog offers. The server accepts only plain slugs
// (a-z, 0-9, -), UUID ids and base64url keys, and the endpoint is the public URL's origin plus a
// fixed path; the URL is still quoted in every command, as a literal word: an IPv6 public URL
// (`http://[::1]:4310/...`) would otherwise be a glob pattern in zsh, and quoting does not rely on
// what the server happens to accept.

/** A word bash and zsh take literally: single quotes, a quote inside as `'\''`. */
export function posixQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

/** PowerShell also reads the typographic single quotes as quote marks. */
const POWERSHELL_QUOTES = new RegExp(
  `['${String.fromCodePoint(0x2018, 0x2019, 0x201a, 0x201b)}]`,
  "g",
)

/** A word PowerShell takes literally: single quotes, every kind of quote mark inside doubled. */
export function powershellQuote(text: string): string {
  return `'${text.replace(POWERSHELL_QUOTES, "$&$&")}'`
}

/**
 * The `claude mcp add` command for a new key: with the key in it, or reading it from the
 * environment (bash/zsh, PowerShell) so it stays out of the shell's history. The last two never
 * hold the key: it is typed, hidden, when they run.
 */
export function connectCommands(slug: string, endpoint: string) {
  const add = (url: string, bearer: string) =>
    `claude mcp add --transport http ${slug} ${url} --header "Authorization: Bearer ${bearer}"`
  return {
    inline: (key: string) => add(posixQuote(endpoint), key),
    bash: [
      "printf 'API key: '; read -rs KERVAN_API_KEY; echo",
      add(posixQuote(endpoint), "$KERVAN_API_KEY"),
      "unset KERVAN_API_KEY",
    ].join("\n"),
    powershell: [
      '$key = Read-Host "API key" -AsSecureString',
      '$env:KERVAN_API_KEY = [Net.NetworkCredential]::new("", $key).Password',
      add(powershellQuote(endpoint), "$env:KERVAN_API_KEY"),
      "Remove-Item Env:KERVAN_API_KEY; Remove-Variable key",
    ].join("\n"),
  }
}
