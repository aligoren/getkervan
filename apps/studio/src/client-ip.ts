import { isIP } from "node:net"

/**
 * The client's IP address. With `trustProxy` = 0 it is the socket address and `X-Forwarded-For`
 * is ignored (clients can write anything there). With N trusted proxies, each proxy appends the
 * address it received the request from, so the client is the Nth entry from the right of
 * `[...X-Forwarded-For, socket]`; entries further left are client-controlled and never used.
 */
export function clientIp(
  socketAddress: string | undefined,
  forwardedFor: string | undefined,
  trustProxy: number,
): string {
  const socket = normalize(socketAddress) ?? "unknown"
  if (trustProxy <= 0) return socket
  const chain = [
    ...(forwardedFor ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ""),
    socket,
  ]
  // Fewer entries than proxies means the request skipped a proxy; the leftmost entry is then the
  // best guess. It is client-written if the client reached Studio without any proxy, which is why
  // Studio must only be reachable through its proxies when proxies are trusted.
  const candidate = chain[Math.max(0, chain.length - 1 - trustProxy)]
  return normalize(candidate) ?? socket
}

function normalize(address: string | undefined): string | undefined {
  if (!address) return undefined
  const trimmed = address.startsWith("::ffff:") ? address.slice(7) : address
  return isIP(trimmed) ? trimmed : undefined
}

/**
 * The key a client's requests are counted under. IPv4 addresses count on their own; IPv6
 * addresses count per /64, because one host or network usually holds a whole /64.
 */
export function rateLimitKey(ip: string): string {
  if (isIP(ip) !== 6) return ip
  const groups = expandIpv6(ip)
  return groups ? `${groups.slice(0, 4).join(":")}::/64` : ip
}

/** The eight 16-bit groups of an IPv6 address, as lowercase hex without leading zeros. */
function expandIpv6(address: string): string[] | undefined {
  let text = address.toLowerCase().split("%")[0] ?? ""
  // An embedded IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) becomes two groups.
  const v4 = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number) as [number, number, number, number]
    text = `${text.slice(0, v4.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const [head, tail] = text.split("::")
  const left = head ? head.split(":") : []
  const right = tail ? tail.split(":") : []
  const missing = 8 - left.length - right.length
  if (missing < 0 || (text.includes("::") ? false : missing !== 0)) return undefined
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right]
  return groups.map((group) => Number.parseInt(group, 16).toString(16))
}
