import { lookup as dnsLookup } from "node:dns/promises"
import { isIP, type LookupFunction } from "node:net"
import { ToolError } from "@kervan/core"
import ipaddr from "ipaddr.js"

export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

/** Resolves a host name to all of its addresses. Injected in tests. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>

export interface NetworkPolicy {
  /**
   * Addresses or CIDR ranges allowed even though they are not public unicast, e.g.
   * `["127.0.0.1/32"]` for local development. Only settable from code or the CLI, never a spec.
   */
  allowPrivate?: readonly string[]
  resolve?: Resolver
}

export class NetworkPolicyError extends Error {
  override name = "NetworkPolicyError"
}

/**
 * Ranges blocked regardless of what the classifier says (defense in depth). Anything that is not
 * public unicast must also fail the classifier, so an address has to pass both to be used.
 */
const BLOCKED_CIDRS = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "::/96",
  "::ffff:0:0/96",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
  // Everything outside 2000::/3 (the only global unicast space): ipaddr.js calls unassigned
  // space such as 4000::/2 or ::1:0:0:1 "unicast", and SIIT (::ffff:0:0:0/96) is only in its list.
  "::/3",
  "4000::/2",
  "8000::/1",
].map((cidr) => ipaddr.parseCIDR(cidr))

type Cidr = [ipaddr.IPv4 | ipaddr.IPv6, number]

function parseAllowList(entries: readonly string[] | undefined): Cidr[] {
  return (entries ?? []).map((entry) => {
    try {
      if (entry.includes("/")) return ipaddr.parseCIDR(entry)
      const address = ipaddr.parse(entry)
      return [address, address.kind() === "ipv4" ? 32 : 128] as Cidr
    } catch {
      throw new NetworkPolicyError(`"${entry}" in allowPrivate is not an IP address or CIDR range.`)
    }
  })
}

function inRanges(address: ipaddr.IPv4 | ipaddr.IPv6, ranges: readonly Cidr[]): boolean {
  return ranges.some(([base, bits]) => address.kind() === base.kind() && address.match(base, bits))
}

export type AddressVerdict = { allowed: true } | { allowed: false; reason: string }

/**
 * Decides whether a resolved address may be contacted. Fails closed: anything that is not a
 * strictly valid IP, or that any check cannot classify as public unicast, is refused.
 */
export function checkAddress(address: string, allowPrivate: readonly Cidr[] = []): AddressVerdict {
  try {
    if (isIP(address) === 0) return { allowed: false, reason: "not a valid IP address" }
    // A zone ID (fe80::1%eth0) selects an interface; no address we may contact needs one.
    if (address.includes("%")) return { allowed: false, reason: "IP address with a zone ID" }
    const raw = ipaddr.parse(address)
    // Unwrap IPv4-mapped IPv6 (::ffff:a.b.c.d), so both forms are judged as the same address.
    const parsed = ipaddr.process(address)
    if (inRanges(parsed, allowPrivate) || inRanges(raw, allowPrivate)) return { allowed: true }
    const range = parsed.range()
    if (range !== "unicast") return { allowed: false, reason: `${range} address` }
    if (inRanges(parsed, BLOCKED_CIDRS) || inRanges(raw, BLOCKED_CIDRS)) {
      return { allowed: false, reason: "reserved or internal address" }
    }
    return { allowed: true }
  } catch {
    return { allowed: false, reason: "address could not be classified" }
  }
}

const defaultResolver: Resolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true })
  return results.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }))
}

export interface ResolvedTarget {
  hostname: string
  addresses: ResolvedAddress[]
  /** Connects only to `addresses`, without resolving again (no DNS rebinding window). */
  lookup: LookupFunction
}

/**
 * Resolves `url`'s host once and checks every address. All of them must be allowed: a host
 * that resolves to one public and one internal address is refused. Fails closed on empty or
 * failed resolution. `signal` bounds the wait: a name server that never answers must not hold
 * the call (the lookup itself cannot be cancelled, but its answer is then ignored).
 */
export async function resolveTarget(
  url: URL,
  policy: NetworkPolicy = {},
  signal?: AbortSignal,
): Promise<ResolvedTarget> {
  const host = url.hostname
  const allow = parseAllowList(policy.allowPrivate)
  const block = (reason: string) => new ToolError(`Request to ${url.host} was blocked: ${reason}.`)

  // URL keeps IPv6 literals in brackets.
  const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  let addresses: ResolvedAddress[]
  if (isIP(literal) !== 0) {
    addresses = [{ address: literal, family: isIP(literal) === 6 ? 6 : 4 }]
  } else {
    if (host === "" || /[^a-z0-9.-]/i.test(host)) throw block("the host name is not valid")
    try {
      addresses = await abortable((policy.resolve ?? defaultResolver)(host), signal)
    } catch {
      if (signal?.aborted) {
        const timedOut = (signal.reason as { name?: unknown } | undefined)?.name === "TimeoutError"
        throw new ToolError(
          `Request to ${url.host} ${timedOut ? "timed out" : "was cancelled"} while resolving the host name.`,
        )
      }
      throw block("the host name could not be resolved")
    }
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw block("the host name resolved to no addresses")
  }
  for (const { address } of addresses) {
    const verdict = checkAddress(address, allow)
    if (!verdict.allowed) throw block(`it resolves to a ${verdict.reason}`)
  }
  return { hostname: host, addresses, lookup: pinnedLookup(literal, addresses) }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    if (signal.aborted) return onAbort()
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

/**
 * A `lookup` for `http.request` that answers only for `hostname`, only with the addresses that
 * were already checked. Handles both signatures Node uses: `(host, options, cb)` with
 * `options.all` (address list) or without (single address), and `(host, family, cb)`.
 */
export function pinnedLookup(
  hostname: string,
  addresses: readonly ResolvedAddress[],
): LookupFunction {
  const lookup = (host: string, options: unknown, callback?: (...args: unknown[]) => void) => {
    const cb = (typeof options === "function" ? options : callback) as (...args: unknown[]) => void
    const opts =
      typeof options === "number"
        ? { family: options }
        : typeof options === "object" && options !== null
          ? (options as { family?: number | string; all?: boolean })
          : {}
    const wanted =
      opts.family === "IPv4" ? 4 : opts.family === "IPv6" ? 6 : Number(opts.family ?? 0)
    const candidates = addresses.filter((a) => wanted === 0 || a.family === wanted)
    process.nextTick(() => {
      const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
      if (bare.toLowerCase() !== hostname.toLowerCase()) {
        return cb(Object.assign(new Error(`Unexpected lookup for ${host}`), { code: "ENOTFOUND" }))
      }
      if (candidates.length === 0) {
        return cb(Object.assign(new Error(`No allowed address for ${host}`), { code: "ENOTFOUND" }))
      }
      if (opts.all)
        return cb(
          null,
          candidates.map((c) => ({ address: c.address, family: c.family })),
        )
      const [first] = candidates
      return cb(null, first?.address, first?.family)
    })
  }
  return lookup as unknown as LookupFunction
}

/** True when `remote` (as reported by the socket) is one of the pinned addresses. */
export function isPinnedAddress(
  remote: string | undefined,
  addresses: readonly ResolvedAddress[],
): boolean {
  if (!remote || isIP(remote) === 0) return false
  try {
    const actual = ipaddr.process(remote).toNormalizedString()
    return addresses.some((a) => ipaddr.process(a.address).toNormalizedString() === actual)
  } catch {
    return false
  }
}
