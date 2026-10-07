// Security review (release): cloud metadata addresses embedded in IPv6 forms when `allowPrivate`
// is wide open. Metadata addresses are refused before any other rule (T3), so even `kervan run
// --allow-private-network` (allowPrivate = 0.0.0.0/0 and ::/0) cannot reach them, in any spelling:
// NAT64 (well-known and local-use prefixes), 6to4, IPv4-compatible and SIIT. On a host with a NAT64
// gateway (common on IPv6-only cloud subnets), 64:ff9b::a9fe:a9fe is 169.254.169.254.
import ipaddr from "ipaddr.js"
import { describe, expect, it } from "vitest"
import { checkAddress, resolveTarget } from "../../src/network.js"

/** What `kervan run --allow-private-network` passes (packages/cli/src/spec-host.ts). */
const ALLOW_ALL = ["0.0.0.0/0", "::/0"]

describe("review-gw: metadata addresses stay refused under allowPrivate in every IPv6 spelling", () => {
  it("baseline: plain and IPv4-mapped forms are refused even with allowPrivate for all", () => {
    for (const address of ["169.254.169.254", "::ffff:169.254.169.254"]) {
      expect(checkAddress(address, { allow: parse(ALLOW_ALL) })).toMatchObject({
        allowed: false,
        reason: "cloud metadata address",
      })
    }
  })

  it.each([
    ["NAT64 (64:ff9b::/96) of 169.254.169.254", "64:ff9b::a9fe:a9fe"],
    ["local-use NAT64 (64:ff9b:1::/48) of 169.254.169.254", "64:ff9b:1::a9fe:a9fe"],
    ["6to4 of 169.254.169.254", "2002:a9fe:a9fe::1"],
    ["IPv4-compatible ::169.254.169.254", "::a9fe:a9fe"],
    ["SIIT ::ffff:0:169.254.169.254", "::ffff:0:a9fe:a9fe"],
    ["NAT64 of Alibaba's 100.100.100.200", "64:ff9b::6464:64c8"],
    ["NAT64 of Azure WireServer 168.63.129.16", "64:ff9b::a83f:8110"],
  ])("refuses %s with allowPrivate for all", (_name, address) => {
    expect(checkAddress(address, { allow: parse(ALLOW_ALL) }).allowed).toBe(false)
  })

  it("refuses a name that resolves to the NAT64 form of the metadata address (kervan run --allow-private-network)", async () => {
    const target = resolveTarget(new URL("https://metadata.example/latest/meta-data/"), {
      allowPrivate: ALLOW_ALL,
      localAddresses: () => [],
      resolve: async () => [{ address: "64:ff9b::a9fe:a9fe", family: 6 }],
    })
    await expect(target).rejects.toThrow(/blocked/)
  })
})

// The same parsing resolveTarget uses for allowPrivate (exact CIDR ranges).
function parse(entries: readonly string[]) {
  return entries.map((entry) => ipaddr.parseCIDR(entry) as [ipaddr.IPv4 | ipaddr.IPv6, number])
}
