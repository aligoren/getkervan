// Security review (phase 4a): the outbound address policy on unusual address forms (T3). Nothing
// here connects anywhere: checkAddress is pure, and resolveTarget only resolves (IP literals, or a
// fake resolver).
import { describe, expect, it } from "vitest"
import { checkAddress, resolveTarget } from "../../src/network.js"

const local = () => [] as string[]

describe("review: checkAddress refuses every internal form", () => {
  it.each([
    "169.254.169.254",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a9fe:a9fe", // NAT64 of the metadata address
    "64:ff9b:1::a9fe:a9fe",
    "2002:a9fe:a9fe::1", // 6to4 of the metadata address
    "2001:0:a9fe:a9fe::1", // Teredo
    "::169.254.169.254", // IPv4-compatible (deprecated)
    "::127.0.0.1",
    "::ffff:0:7f00:1", // SIIT
    "0.0.0.0",
    "0.1.2.3",
    "127.1.2.3",
    "100.100.100.200",
    "192.0.0.192",
    "198.18.0.1",
    "255.255.255.255",
    "224.0.0.1",
    "fd00:ec2::254",
    "fe80::1",
    "fe80::1%eth0",
    "ff02::1",
    "::",
    "::1",
    "100::1",
    "2001:db8::1",
    "3fff::1",
    "5f00::1",
  ])("refuses %s", (address) => {
    expect(checkAddress(address, { local: [] }).allowed).toBe(false)
  })

  it("allows a public unicast address (sanity)", () => {
    expect(checkAddress("93.184.215.14").allowed).toBe(true)
    expect(checkAddress("2606:4700::1").allowed).toBe(true)
  })
})

describe("review: URL literal forms are judged as the address they name", () => {
  it.each([
    "http://0177.0.0.1/",
    "http://0x7f000001/",
    "http://2130706433/",
    "http://127.1/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:7f00:1]/",
    "http://[0:0:0:0:0:ffff:a9fe:a9fe]/",
    "http://169.254.169.254./",
  ])("refuses %s", async (url) => {
    await expect(resolveTarget(new URL(url), { localAddresses: local })).rejects.toThrow(/blocked/)
  })

  it("refuses a name whose answers mix a public and an internal address", async () => {
    const resolve = async () => [
      { address: "93.184.215.14", family: 4 as const },
      { address: "::ffff:10.0.0.1", family: 6 as const },
    ]
    await expect(
      resolveTarget(new URL("https://mixed.test/"), { resolve, localAddresses: local }),
    ).rejects.toThrow(/blocked/)
  })

  it("refuses a name that resolves to nothing, or to a non-address", async () => {
    for (const answer of [[], [{ address: "localhost", family: 4 as const }]]) {
      await expect(
        resolveTarget(new URL("https://odd.test/"), {
          resolve: async () => answer,
          localAddresses: local,
        }),
      ).rejects.toThrow(/blocked/)
    }
  })

  it("applies a deny list to every spelling of the address", async () => {
    const policy = {
      denyList: ["203.0.113.0/24", "2001:db8:aaaa::/48"],
      allowPrivate: ["203.0.113.0/24", "2001:db8::/32"],
      localAddresses: local,
    }
    for (const url of [
      "http://203.0.113.9/",
      "http://[::ffff:203.0.113.9]/",
      "http://3405803785/",
      "http://[2001:db8:aaaa::1]/",
    ]) {
      await expect(resolveTarget(new URL(url), policy), url).rejects.toThrow(/deny list/)
    }
  })
})
