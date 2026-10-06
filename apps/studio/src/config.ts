import path from "node:path"

export interface StudioConfig {
  /**
   * The canonical origin people and clients use, e.g. `https://studio.example.com`. Origin
   * checks, the session cookie (`Secure`, `__Host-` prefix), the allowed `Host` header and the
   * SSRF deny list (Studio's own address) all derive from it.
   */
  publicUrl: URL
  /** Interface to listen on once an admin exists (until then, always 127.0.0.1). */
  host: string
  port: number
  dataDir: string
  /**
   * How many reverse proxies in front of Studio append to `X-Forwarded-For`. 0 (the default)
   * ignores the header and uses the socket address as the client IP.
   */
  trustProxy: number
  /** Extra addresses or CIDR ranges spec tools may never reach (internal infrastructure). */
  denyNetwork: string[]
  /** Call logs older than this many days are deleted. Default: 30. */
  logRetentionDays: number
}

export class ConfigError extends Error {
  override name = "ConfigError"
}

export const DEFAULT_PORT = 4310
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])
const MAX_PROXY_HOPS = 10

/** Reads Studio's settings from `KERVAN_STUDIO_*` environment variables. */
export function loadConfig(env: NodeJS.ProcessEnv, cwd = process.cwd()): StudioConfig {
  const port = parsePort(env.KERVAN_STUDIO_PORT)
  const host = env.KERVAN_STUDIO_HOST?.trim() || "127.0.0.1"
  const rawUrl = env.KERVAN_STUDIO_PUBLIC_URL?.trim()
  if (!rawUrl && !LOOPBACK_HOSTS.has(host)) {
    throw new ConfigError(
      `KERVAN_STUDIO_PUBLIC_URL is required when listening on ${host}: set it to the URL people ` +
        "use to reach Studio, e.g. https://studio.example.com.",
    )
  }
  return {
    publicUrl: parsePublicUrl(rawUrl || `http://127.0.0.1:${port}`),
    host,
    port,
    dataDir: path.resolve(cwd, env.KERVAN_STUDIO_DATA_DIR?.trim() || ".kervan-studio"),
    trustProxy: parseTrustProxy(env.KERVAN_STUDIO_TRUST_PROXY),
    denyNetwork: (env.KERVAN_STUDIO_DENY_NETWORK ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
    logRetentionDays: parseRetention(env.KERVAN_STUDIO_LOG_RETENTION_DAYS),
  }
}

export function parsePublicUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConfigError(`KERVAN_STUDIO_PUBLIC_URL is not a valid URL: ${raw}`)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("KERVAN_STUDIO_PUBLIC_URL must start with https:// (or http://).")
  }
  if (url.username || url.password) {
    throw new ConfigError("KERVAN_STUDIO_PUBLIC_URL must not contain credentials.")
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new ConfigError(
      "KERVAN_STUDIO_PUBLIC_URL must be an origin only (no path, query or fragment); serving " +
        "Studio under a sub-path is not supported.",
    )
  }
  return new URL(url.origin)
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PORT
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ConfigError(`KERVAN_STUDIO_PORT must be a port number, not "${raw}".`)
  }
  return port
}

function parseRetention(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 30
  const days = Number(raw)
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    throw new ConfigError(
      `KERVAN_STUDIO_LOG_RETENTION_DAYS must be a whole number of days (1-3650), not "${raw}".`,
    )
  }
  return days
}

function parseTrustProxy(raw: string | undefined): number {
  const value = raw?.trim().toLowerCase()
  if (value === undefined || value === "" || value === "false" || value === "0") return 0
  const hops = Number(value)
  if (!Number.isInteger(hops) || hops < 1 || hops > MAX_PROXY_HOPS) {
    throw new ConfigError(
      `KERVAN_STUDIO_TRUST_PROXY must be the number of trusted proxies (1-${MAX_PROXY_HOPS}) or ` +
        `false, not "${raw}".`,
    )
  }
  return hops
}

/** Whether the public URL is served over https (Secure cookies, `__Host-` prefix). */
export function isSecure(config: Pick<StudioConfig, "publicUrl">): boolean {
  return config.publicUrl.protocol === "https:"
}

/** Host names accepted in the `Host` header (DNS rebinding protection). */
export function allowedHostNames(config: Pick<StudioConfig, "publicUrl">): string[] {
  const host = config.publicUrl.hostname
  return LOOPBACK_HOSTS.has(host) ? ["127.0.0.1", "localhost", "[::1]"] : [host]
}

/** Until an admin exists, Studio only listens on loopback, whatever `host` says. */
export function bindHost(config: Pick<StudioConfig, "host">, hasAdmin: boolean): string {
  return hasAdmin ? config.host : "127.0.0.1"
}
