import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import type { LookupGate, NetworkPolicy, Resolver } from "@kervan/spec-runtime"

/** Why an address or CIDR range is not valid, or `undefined` if it is. */
export function addressRangeProblem(entry: string): string | undefined {
  const [address = "", prefix, extra] = entry.split("/")
  const family = isIP(address)
  if (family === 0 || extra !== undefined) return `"${entry}" is not an IP address or CIDR range.`
  if (prefix === undefined) return undefined
  const bits = Number(prefix)
  const max = family === 4 ? 32 : 128
  if (!/^\d{1,3}$/.test(prefix) || bits > max) {
    return `"${entry}" has an invalid prefix length (0-${max}).`
  }
  return undefined
}

/** What a deployment (or a test) may tune. There is deliberately no way to allow private ranges. */
export interface StudioNetworkOptions {
  /** Infrastructure addresses or ranges to refuse in addition to the defaults. */
  denyList?: readonly string[]
  /** Addresses Studio itself is reachable at (resolved from the public URL at startup). */
  selfAddresses?: readonly string[]
  resolve?: Resolver
  localAddresses?: () => readonly string[]
  lookupGate?: LookupGate
}

/**
 * The SSRF policy for every spec tool Studio runs: the runtime's defaults (public unicast only,
 * cloud metadata always refused) minus the configured infrastructure and Studio's own addresses.
 * It is built field by field, so an `allowPrivate` passed in from anywhere is dropped.
 */
export function studioNetworkPolicy(options: StudioNetworkOptions = {}): NetworkPolicy {
  const denyList = [...(options.denyList ?? []), ...(options.selfAddresses ?? []).map(asRange)]
  return {
    denyList,
    ...(options.resolve ? { resolve: options.resolve } : {}),
    ...(options.localAddresses ? { localAddresses: options.localAddresses } : {}),
    ...(options.lookupGate ? { lookupGate: options.lookupGate } : {}),
  }
}

/** Resolves the public URL's host to the addresses tools must never call back into. */
export async function resolveSelfAddresses(
  hostname: string,
  resolve: (host: string) => Promise<string[]> = defaultResolve,
): Promise<string[]> {
  const host = hostname.replace(/^\[(.*)\]$/, "$1")
  if (isIP(host)) return [host]
  return resolve(host)
}

async function defaultResolve(host: string): Promise<string[]> {
  const results = await lookup(host, { all: true, verbatim: true })
  return results.map((result) => result.address)
}

function asRange(address: string): string {
  if (address.includes("/")) return address
  return isIP(address) === 6 ? `${address}/128` : `${address}/32`
}
