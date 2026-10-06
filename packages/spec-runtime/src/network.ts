import { lookup as dnsLookup } from "node:dns/promises"
import { isIP, type LookupFunction } from "node:net"
import { networkInterfaces } from "node:os"
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
  /** Addresses or CIDR ranges that are always refused, even if `allowPrivate` lists them. */
  denyList?: readonly string[]
  /**
   * This machine's own addresses, refused by default because services listening on all
   * interfaces are reachable through them even when they are public. Default: every address of
   * `os.networkInterfaces()`.
   */
  localAddresses?: () => readonly string[]
  resolve?: Resolver
  /** Caps concurrent DNS lookups. Default: the process-wide gate (see `LookupGate`). */
  lookupGate?: LookupGate
}

/** Raised when a queued DNS lookup gives up waiting for a free slot. */
class LookupQueueTimeout extends Error {}

/**
 * Caps how many DNS lookups are in flight. `dns.lookup` runs on libuv's thread pool and cannot be
 * cancelled, so a slow name server could otherwise occupy every thread (also used by the file
 * system and crypto). A slot is released only when the lookup itself finishes, not when a caller
 * stops waiting; callers queue, and leave the queue when their signal aborts.
 */
export class LookupGate {
  readonly limit: number
  #active = 0
  readonly #queue: { start: () => void; fail: (error: unknown) => void }[] = []

  constructor(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new NetworkPolicyError("The DNS lookup limit must be a positive integer.")
    }
    this.limit = limit
  }

  get active(): number {
    return this.#active
  }

  get queued(): number {
    return this.#queue.length
  }

  /**
   * Waits for a free slot (rejecting if `signal` aborts first), then starts `lookup`. Resolves
   * with the running lookup, wrapped so the caller can wait for it separately.
   */
  async start<T>(lookup: () => Promise<T>, signal?: AbortSignal): Promise<{ result: Promise<T> }> {
    await this.#acquire(signal)
    let result: Promise<T>
    try {
      result = lookup()
    } catch (error) {
      this.#release()
      throw error
    }
    result.then(
      () => this.#release(),
      () => this.#release(),
    )
    return { result }
  }

  #acquire(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return Promise.reject(new LookupQueueTimeout())
    if (this.#active < this.limit) {
      this.#active++
      return Promise.resolve()
    }
    return new Promise((resolve, reject) => {
      const entry = {
        start: () => {
          signal?.removeEventListener("abort", onAbort)
          this.#active++
          resolve()
        },
        fail: reject,
      }
      const onAbort = () => {
        const index = this.#queue.indexOf(entry)
        if (index !== -1) this.#queue.splice(index, 1)
        reject(new LookupQueueTimeout())
      }
      signal?.addEventListener("abort", onAbort, { once: true })
      this.#queue.push(entry)
    })
  }

  #release(): void {
    this.#active--
    this.#queue.shift()?.start()
  }
}

/** Half of libuv's thread pool (`UV_THREADPOOL_SIZE`, default 4), at least 1. */
export function defaultLookupLimit(env: NodeJS.ProcessEnv = process.env): number {
  const pool = Number(env.UV_THREADPOOL_SIZE)
  const size = Number.isInteger(pool) && pool >= 1 ? Math.min(pool, 1024) : 4
  return Math.max(1, Math.floor(size / 2))
}

const processLookupGate = new LookupGate(defaultLookupLimit())

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

function parseCidrList(entries: readonly string[] | undefined, option: string): Cidr[] {
  return (entries ?? []).map((entry) => {
    try {
      if (entry.includes("/")) return ipaddr.parseCIDR(entry)
      const address = ipaddr.parse(entry)
      return [address, address.kind() === "ipv4" ? 32 : 128] as Cidr
    } catch {
      throw new NetworkPolicyError(`"${entry}" in ${option} is not an IP address or CIDR range.`)
    }
  })
}

function systemAddresses(): string[] {
  return Object.values(networkInterfaces()).flatMap((list) => (list ?? []).map((i) => i.address))
}

/** This machine's addresses as exact ranges. Throws if they cannot be listed or parsed. */
function localRanges(policy: NetworkPolicy): Cidr[] {
  return (policy.localAddresses ?? systemAddresses)().map((address) => {
    // Interface addresses may carry a zone (fe80::1%eth0); the address itself is what counts.
    const bare = address.split("%")[0] ?? ""
    const parsed = ipaddr.process(bare)
    return [parsed, parsed.kind() === "ipv4" ? 32 : 128] as Cidr
  })
}

/** Ranges the checks use; built once per request. */
export interface AddressRules {
  allow?: readonly Cidr[]
  deny?: readonly Cidr[]
  local?: readonly Cidr[]
}

function inRanges(address: ipaddr.IPv4 | ipaddr.IPv6, ranges: readonly Cidr[]): boolean {
  return ranges.some(([base, bits]) => address.kind() === base.kind() && address.match(base, bits))
}

export type AddressVerdict = { allowed: true } | { allowed: false; reason: string }

/**
 * Decides whether a resolved address may be contacted. Fails closed: anything that is not a
 * strictly valid IP, or that any check cannot classify as public unicast, is refused.
 */
export function checkAddress(address: string, rules: AddressRules = {}): AddressVerdict {
  try {
    if (isIP(address) === 0) return { allowed: false, reason: "not a valid IP address" }
    // A zone ID (fe80::1%eth0) selects an interface; no address we may contact needs one.
    if (address.includes("%")) return { allowed: false, reason: "IP address with a zone ID" }
    const raw = ipaddr.parse(address)
    // Unwrap IPv4-mapped IPv6 (::ffff:a.b.c.d), so both forms are judged as the same address.
    const parsed = ipaddr.process(address)
    const matches = (ranges: readonly Cidr[] | undefined) =>
      ranges !== undefined && (inRanges(parsed, ranges) || inRanges(raw, ranges))
    // Order: explicit deny, explicit allow, this machine, then the public-unicast checks.
    if (matches(rules.deny)) return { allowed: false, reason: "address on the deny list" }
    if (matches(rules.allow)) return { allowed: true }
    if (matches(rules.local)) return { allowed: false, reason: "address of this machine" }
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
  const block = (reason: string) => new ToolError(`Request to ${url.host} was blocked: ${reason}.`)
  const rules: AddressRules = {
    allow: parseCidrList(policy.allowPrivate, "allowPrivate"),
    deny: parseCidrList(policy.denyList, "denyList"),
  }
  try {
    rules.local = localRanges(policy)
  } catch {
    // Without the list, an address of this machine could slip through: refuse instead.
    throw block("this machine's own addresses could not be determined")
  }

  // URL keeps IPv6 literals in brackets.
  const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host
  let addresses: ResolvedAddress[]
  if (isIP(literal) !== 0) {
    addresses = [{ address: literal, family: isIP(literal) === 6 ? 6 : 4 }]
  } else {
    if (host === "" || /[^a-z0-9.-]/i.test(host)) throw block("the host name is not valid")
    const resolver = policy.resolve ?? defaultResolver
    const gate = policy.lookupGate ?? processLookupGate
    let running: { result: Promise<ResolvedAddress[]> }
    try {
      running = await gate.start(() => resolver(host), signal)
    } catch (error) {
      if (error instanceof LookupQueueTimeout) {
        throw new ToolError(
          `Request to ${url.host} timed out waiting for a DNS lookup slot (${gate.limit} in use).`,
        )
      }
      throw block("the host name could not be resolved")
    }
    try {
      addresses = await abortable(running.result, signal)
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
    const verdict = checkAddress(address, rules)
    // The address itself is left out: it could reveal internal DNS names to the model.
    if (!verdict.allowed) throw block(`it resolves to a disallowed address (${verdict.reason})`)
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
