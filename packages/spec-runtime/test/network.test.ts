import { createApp, type ToolContext } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"
import type { Client } from "@modelcontextprotocol/client"
import ipaddr from "ipaddr.js"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { sendHttp } from "../src/http.js"
import {
  applySpec,
  checkAddress,
  loadSpec,
  NetworkPolicyError,
  pinnedLookup,
  type ResolvedAddress,
  type Resolver,
  resolveTarget,
} from "../src/index.js"
import { isPinnedAddress } from "../src/network.js"
import { startUpstream, type Upstream } from "./upstream.js"

let upstream: Upstream
let port: number
beforeAll(async () => {
  upstream = await startUpstream()
  port = Number(new URL(upstream.url).port)
})
afterAll(() => upstream.close())
afterEach(() => {
  vi.restoreAllMocks()
})

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 })
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 })
const fixed =
  (...addresses: ResolvedAddress[]): Resolver =>
  async () =>
    addresses

describe("checkAddress: only public unicast passes", () => {
  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e"])(
    "allows %s",
    (address) => {
      expect(checkAddress(address)).toEqual({ allowed: true })
    },
  )

  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.1.2.3", "private"],
    ["172.31.255.255", "private"],
    ["192.168.0.1", "private"],
    ["169.254.169.254", "cloud metadata / link-local"],
    ["100.64.0.1", "CGNAT"],
    ["100.100.100.200", "Alibaba metadata (CGNAT)"],
    ["0.0.0.0", "unspecified"],
    ["0.1.2.3", "this network"],
    ["255.255.255.255", "broadcast"],
    ["224.0.0.251", "multicast"],
    ["240.0.0.1", "reserved"],
    ["192.0.0.170", "IETF protocol assignments"],
    ["192.0.2.10", "documentation"],
    ["198.18.0.1", "benchmarking"],
    ["::1", "IPv6 loopback"],
    ["::", "IPv6 unspecified"],
    ["fe80::1", "IPv6 link-local"],
    ["fd00:ec2::254", "AWS IPv6 metadata (ULA)"],
    ["fc00::1", "ULA"],
    ["ff02::1", "IPv6 multicast"],
    ["::ffff:8.8.8.8", "IPv4-mapped form, even of a public address (refused outright)"],
    ["::ffff:127.0.0.1", "IPv4-mapped loopback"],
    ["::ffff:7f00:1", "IPv4-mapped loopback (hex)"],
    ["::ffff:169.254.169.254", "IPv4-mapped metadata"],
    ["::127.0.0.1", "IPv4-compatible loopback"],
    ["64:ff9b::7f00:1", "NAT64 of loopback"],
    ["64:ff9b::a9fe:a9fe", "NAT64 of metadata"],
    ["2002:7f00:1::1", "6to4 of loopback"],
    ["2001::1", "Teredo"],
    ["2001:db8::1", "IPv6 documentation"],
    ["2001:2::1", "IPv6 benchmarking"],
    ["fec0::1", "site-local (deprecated)"],
    ["100::1", "discard-only"],
    ["::ffff:0:7f00:1", "IPv4-translated (SIIT) loopback"],
    ["::1:0:0:1", "IANA reserved, outside 2000::/3 (ipaddr calls it unicast)"],
    ["4000::1", "IANA reserved, outside 2000::/3 (ipaddr calls it unicast)"],
    ["fe00::1", "IANA reserved, outside 2000::/3 (ipaddr calls it unicast)"],
  ])("blocks %s (%s)", (address) => {
    expect(checkAddress(address).allowed).toBe(false)
  })

  it.each([
    "",
    "localhost",
    "2130706433",
    "0177.0.0.1",
    "0x7f.0.0.1",
    "127.1",
    "1.2.3",
    "08.08.08.08",
    " 8.8.8.8",
    "8.8.8.8 ",
    "::ffff:999.1.1.1",
    "[::1]",
    "8.8.8.8/32",
    // Zone IDs pick an interface; a public address has no business carrying one.
    "2606:4700::1%eth0",
    "2606:4700::1%1",
  ])("fails closed on %j (not a strictly valid IP)", (address) => {
    expect(checkAddress(address).allowed).toBe(false)
  })

  it("fails closed when the classifier throws", () => {
    vi.spyOn(ipaddr, "process").mockImplementation(() => {
      throw new Error("classifier broke")
    })
    expect(checkAddress("8.8.8.8")).toEqual({
      allowed: false,
      reason: "address could not be classified",
    })
  })

  it("keeps blocking internal ranges even if the classifier says unicast", () => {
    // The CIDR list is an independent layer: break the first one and the second still holds.
    vi.spyOn(ipaddr.IPv4.prototype, "range").mockReturnValue("unicast")
    vi.spyOn(ipaddr.IPv6.prototype, "range").mockReturnValue("unicast")
    for (const address of [
      "10.0.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "64:ff9b::a00:1",
      "::ffff:0:7f00:1",
      "::1:0:0:1",
      "4000::1",
      "fe00::1",
    ]) {
      expect(checkAddress(address).allowed, address).toBe(false)
    }
    expect(checkAddress("8.8.8.8").allowed).toBe(true)
  })
})

describe("allowPrivate", () => {
  it("allows exactly the listed ranges", async () => {
    const policy = { allowPrivate: ["127.0.0.1/32"], resolve: fixed(v4("127.0.0.1")) }
    await expect(resolveTarget(new URL("http://local.test/"), policy)).resolves.toBeDefined()
    await expect(
      resolveTarget(new URL("http://local.test/"), { ...policy, resolve: fixed(v4("127.0.0.2")) }),
    ).rejects.toThrow(/blocked/)
  })

  it("rejects malformed entries instead of ignoring them", async () => {
    await expect(
      resolveTarget(new URL("https://example.com/"), {
        allowPrivate: ["not-an-ip"],
        resolve: fixed(v4("8.8.8.8")),
      }),
    ).rejects.toBeInstanceOf(NetworkPolicyError)
  })
})

describe("resolveTarget", () => {
  it.each([
    "http://2130706433/",
    "http://0x7f.0.0.1/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://0/",
    "http://[::1]/",
    "http://[0:0:0:0:0:0:0:1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::ffff:a9fe:a9fe]/",
    "http://[::]/",
    "http://0.0.0.0/",
    "http://169.254.169.254/latest/meta-data/",
    "http://[fd00:ec2::254]/",
    "http://%31%32%37.0.0.1/",
    "http://１２７.０.０.１/",
    "http://127.0.0.1./",
    "http://127.000.000.001/",
    "http://0300.0250.0.1/",
    "http://0xC0A80001/",
    "http://3232235521/",
    "http://[0:0:0:0:0:FFFF:7F00:0001]/",
    "http://[::ffff:0:7f00:1]/",
    "http://[64:ff9b::a9fe:a9fe]/",
  ])("blocks the IP literal in %s after URL normalization", async (url) => {
    const resolve = vi.fn(fixed(v4("8.8.8.8")))
    await expect(resolveTarget(new URL(url), { resolve })).rejects.toThrow(/was blocked/)
    expect(resolve).not.toHaveBeenCalled()
  })

  it.each([
    ["no addresses", fixed()],
    ["a resolver error", async () => Promise.reject(new Error("SERVFAIL"))],
    ["a non-array answer", (async () => undefined) as unknown as Resolver],
    ["one internal address among public ones", fixed(v4("8.8.8.8"), v4("10.0.0.1"))],
    ["an IPv6 loopback next to a public IPv4", fixed(v4("8.8.8.8"), v6("::1"))],
    ["a malformed address", fixed(v4("not-an-ip"))],
    ["a mapped internal address", fixed(v6("::ffff:10.0.0.1"))],
  ])("fails closed on %s", async (_label, resolve) => {
    await expect(resolveTarget(new URL("https://api.example.com/"), { resolve })).rejects.toThrow(
      /was blocked/,
    )
  })

  it("blocks localhost resolving to both loopbacks", async () => {
    const resolve = fixed(v6("::1"), v4("127.0.0.1"))
    await expect(resolveTarget(new URL("http://localhost/"), { resolve })).rejects.toThrow(
      /loopback/,
    )
  })

  it("rejects host names with unexpected characters", async () => {
    const url = new URL("https://api.example.com/")
    Object.defineProperty(url, "hostname", { value: "evil_host" })
    await expect(resolveTarget(url, { resolve: fixed(v4("8.8.8.8")) })).rejects.toThrow(/not valid/)
  })

  it("resolves once and pins the answer (no DNS rebinding)", async () => {
    let calls = 0
    const resolve: Resolver = async () => (++calls === 1 ? [v4("8.8.8.8")] : [v4("127.0.0.1")])
    const target = await resolveTarget(new URL("https://rebind.example/"), { resolve })
    const answers = await Promise.all(
      [0, 1, 2].map(
        () =>
          new Promise((done) =>
            target.lookup("rebind.example", { all: true }, (_err, addresses) => done(addresses)),
          ),
      ),
    )
    expect(calls).toBe(1)
    expect(answers).toEqual([[v4("8.8.8.8")], [v4("8.8.8.8")], [v4("8.8.8.8")]])
  })
})

describe("pinnedLookup signatures", () => {
  const lookup = pinnedLookup("dual.example", [v6("2606:4700::1"), v4("1.1.1.1")])
  const call = (host: string, options: unknown) =>
    new Promise<unknown[]>((resolve) => {
      ;(lookup as unknown as (h: string, o: unknown, cb: (...args: unknown[]) => void) => void)(
        host,
        options,
        (...args) => resolve(args),
      )
    })

  it.each([
    [{ all: true }, [null, [v6("2606:4700::1"), v4("1.1.1.1")]]],
    [{ all: true, family: 4 }, [null, [v4("1.1.1.1")]]],
    [{ all: true, family: "IPv6" }, [null, [v6("2606:4700::1")]]],
    [{}, [null, "2606:4700::1", 6]],
    [{ family: 4 }, [null, "1.1.1.1", 4]],
    [6, [null, "2606:4700::1", 6]],
    [0, [null, "2606:4700::1", 6]],
  ])("options %j", async (options, expected) => {
    expect(await call("dual.example", options)).toEqual(expected)
  })

  it("accepts the two-argument form", async () => {
    const result = await new Promise<unknown[]>((resolve) => {
      ;(lookup as unknown as (h: string, cb: (...args: unknown[]) => void) => void)(
        "dual.example",
        (...args) => resolve(args),
      )
    })
    expect(result).toEqual([null, "2606:4700::1", 6])
  })

  it.each([["other.example"], ["DUAL.example.evil"]])("refuses to answer for %s", async (host) => {
    const [error] = await call(host, { all: true })
    expect(error).toBeInstanceOf(Error)
  })

  it("answers with an error when no address has the requested family", async () => {
    const only4 = pinnedLookup("v4.example", [v4("1.1.1.1")])
    const [error] = await new Promise<unknown[]>((resolve) => {
      ;(only4 as unknown as (h: string, o: unknown, cb: (...a: unknown[]) => void) => void)(
        "v4.example",
        { family: 6 },
        (...args) => resolve(args),
      )
    })
    expect(error).toBeInstanceOf(Error)
  })
})

describe("connection checks", () => {
  const ctx = { signal: new AbortController().signal } as unknown as ToolContext
  void ctx

  it("connects to the pinned address and keeps the Host header", async () => {
    const target = await resolveTarget(new URL(`http://api.internal.test:${port}/`), {
      allowPrivate: ["127.0.0.1/32"],
      resolve: fixed(v4("127.0.0.1")),
    })
    const response = await sendHttp(
      { method: "GET", url: new URL(`http://api.internal.test:${port}/echo`), headers: {} },
      { timeoutMs: 2000, maxResponseBytes: 100_000, target },
    )
    expect(JSON.parse(response.body.toString()).headers.host).toBe(`api.internal.test:${port}`)
  })

  it("connects to a host that resolves to IPv4 and IPv6 (all: true lookups)", async () => {
    const target = await resolveTarget(new URL(`http://dual.test:${port}/`), {
      allowPrivate: ["127.0.0.1/32", "::1/128"],
      resolve: fixed(v6("::1"), v4("127.0.0.1")),
    })
    const response = await sendHttp(
      { method: "GET", url: new URL(`http://dual.test:${port}/echo`), headers: {} },
      { timeoutMs: 2000, maxResponseBytes: 100_000, target },
    )
    expect(response.status).toBe(200)
  })

  it("refuses a socket connected to an address that was not checked", async () => {
    // A lookup that misbehaves (answers 127.0.0.1) while the checked list says 127.0.0.2.
    const target = {
      hostname: "liar.test",
      addresses: [v4("127.0.0.2")],
      lookup: pinnedLookup("liar.test", [v4("127.0.0.1")]),
    }
    const before = upstream.requests.length
    await expect(
      sendHttp(
        { method: "GET", url: new URL(`http://liar.test:${port}/echo`), headers: {} },
        { timeoutMs: 2000, maxResponseBytes: 100_000, target },
      ),
    ).rejects.toThrow(/blocked|failed/)
    expect(upstream.requests.length).toBe(before)
  })

  it("refuses a target checked for another host", async () => {
    const target = await resolveTarget(new URL("https://checked.example/"), {
      resolve: fixed(v4("8.8.8.8")),
    })
    await expect(
      sendHttp(
        { method: "GET", url: new URL(`http://127.0.0.1:${port}/echo`), headers: {} },
        { timeoutMs: 2000, maxResponseBytes: 100_000, target },
      ),
    ).rejects.toThrow(/was not checked/)
  })

  it("isPinnedAddress compares normalized forms and fails closed", () => {
    expect(isPinnedAddress("::ffff:127.0.0.1", [v4("127.0.0.1")])).toBe(true)
    expect(isPinnedAddress("127.0.0.2", [v4("127.0.0.1")])).toBe(false)
    expect(isPinnedAddress(undefined, [v4("127.0.0.1")])).toBe(false)
    expect(isPinnedAddress("garbage", [v4("127.0.0.1")])).toBe(false)
  })
})

describe("spec tools behind the policy", () => {
  const clients: Client[] = []
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()))
  })

  async function serve(tool: string, resolve: Resolver, allowPrivate = ["127.0.0.1/32"]) {
    const loaded = await loadSpec(
      `specVersion: 1
name: net
version: 0.0.0
secrets: [API_KEY]
defaults: { http: { allowInsecureHttp: true, timeoutMs: 2000 } }
tools:
${tool}`,
      {
        secrets: { get: () => "secret-value-123456" },
        network: { allowPrivate, resolve },
      },
    )
    const app = createApp({ name: "net", version: "0" })
    applySpec(app.registry, loaded)
    const client = await createTestClient(app)
    clients.push(client)
    return client
  }

  const text = (r: unknown) =>
    (r as { content: { text?: string }[] }).content.map((b) => b.text ?? "").join("")

  const redirectTool = (to: string, extra = "", status = 302) => `
  - name: hop
    description: d
    http:
      method: GET
      url: "http://api.test:PORT/redirect-to?status=${status}&to=${encodeURIComponent(to)}"
      followRedirects: 3
      headers: { X-Key: "{{secrets.API_KEY}}", Authorization: "Bearer {{secrets.API_KEY}}", X-Plain: kept }
      ${extra}
    output: { select: "{path: path, headers: headers}" }`

  // api.test and other.test both reach the local upstream.
  const resolver: Resolver = async (host) =>
    host === "api.test" || host === "other.test" ? [v4("127.0.0.1")] : [v4("8.8.8.8")]

  it("blocks a redirect to cloud metadata", async () => {
    const client = await serve(
      redirectTool("http://169.254.169.254/latest/meta-data/").replaceAll("PORT", String(port)),
      resolver,
    )
    const result = await client.callTool({ name: "hop", arguments: {} })
    expect(text(result)).toMatch(/169\.254\.169\.254 was blocked/)
  })

  it("blocks a redirect to an internal name even when the first hop was allowed", async () => {
    const internal: Resolver = async (host) =>
      host === "api.test" ? [v4("127.0.0.1")] : [v4("10.0.0.7")]
    const client = await serve(
      redirectTool(`http://intranet.test:${port}/echo`).replaceAll("PORT", String(port)),
      internal,
    )
    expect(text(await client.callTool({ name: "hop", arguments: {} }))).toMatch(
      /intranet\.test.*blocked/,
    )
  })

  it("blocks IPv4-mapped and encoded loopback variants in Location", async () => {
    for (const to of [
      `http://[::ffff:127.0.0.2]:${port}/echo`,
      `http://2130706434:${port}/echo`,
      `http://0x7f000002:${port}/echo`,
      `//127.0.0.2:${port}/echo`,
      `/\\127.0.0.2:${port}/echo`,
    ]) {
      const client = await serve(redirectTool(to).replaceAll("PORT", String(port)), resolver)
      expect(text(await client.callTool({ name: "hop", arguments: {} })), to).toMatch(/blocked/)
    }
  })

  it("follows a same-origin redirect with all headers", async () => {
    const client = await serve(
      redirectTool("/echo/after").replaceAll("PORT", String(port)),
      resolver,
    )
    const echoed = JSON.parse(text(await client.callTool({ name: "hop", arguments: {} })))
    expect(echoed.path).toBe("/echo/after")
    expect(echoed.headers["x-key"]).toBe("[redacted]")
    expect(echoed.headers["x-plain"]).toBe("kept")
  })

  it("drops secret and credential headers when the host changes", async () => {
    const client = await serve(
      redirectTool(`http://other.test:${port}/echo/elsewhere`).replaceAll("PORT", String(port)),
      resolver,
    )
    const echoed = JSON.parse(text(await client.callTool({ name: "hop", arguments: {} })))
    expect(echoed.path).toBe("/echo/elsewhere")
    expect(echoed.headers.host).toBe(`other.test:${port}`)
    expect(echoed.headers).not.toHaveProperty("x-key")
    expect(echoed.headers).not.toHaveProperty("authorization")
    expect(echoed.headers["x-plain"]).toBe("kept")
    const last = upstream.requests.at(-1)
    expect(last?.headers).not.toHaveProperty("x-key")
  })

  it.each([
    ["file:///etc/passwd", /disallowed scheme/],
    [`http://user:pass@api.test:${0}/echo`, /credentials/],
    ["", /without a location/],
  ])("refuses a redirect to %j", async (to, pattern) => {
    const location = to === "" ? undefined : to.replace(":0/", `:${port}/`)
    const tool =
      location === undefined ? redirectTool("x").replace(/&to=[^"]*/, "") : redirectTool(location)
    const client = await serve(tool.replaceAll("PORT", String(port)), resolver)
    expect(text(await client.callTool({ name: "hop", arguments: {} }))).toMatch(pattern)
  })

  it("stops after followRedirects hops", async () => {
    const loop = `http://api.test:${port}/redirect-to?to=${encodeURIComponent(`http://api.test:${port}/redirect-to?to=${encodeURIComponent(`http://api.test:${port}/redirect-to?to=${encodeURIComponent(`http://api.test:${port}/redirect-to?to=%2Fecho`)}`)}`)}`
    const client = await serve(redirectTool(loop).replaceAll("PORT", String(port)), resolver)
    expect(text(await client.callTool({ name: "hop", arguments: {} }))).toMatch(/more than 3 times/)
  })

  it("never sends a request body to another host", async () => {
    const tool = `
  - name: post_hop
    description: d
    http:
      method: POST
      url: "http://api.test:${port}/redirect-to?status=307&to=${encodeURIComponent(`http://other.test:${port}/echo`)}"
      followRedirects: 2
      body: { token: "{{secrets.API_KEY}}" }
    output: { select: "@" }`
    const client = await serve(tool, resolver)
    expect(text(await client.callTool({ name: "post_hop", arguments: {} }))).toMatch(
      /another host with a request body/,
    )
  })

  it("bounds name resolution by the request timeout and frees the call slot", async () => {
    // A name server that never answers must not hold the tool's only call slot forever.
    let calls = 0
    const hangsOnce: Resolver = (_host) =>
      ++calls === 1 ? new Promise(() => {}) : Promise.resolve([v4("127.0.0.1")])
    const tool = `
  - name: slow_dns
    description: d
    rateLimit: { concurrency: 1 }
    http:
      method: GET
      url: "http://hang.test:${port}/echo"
      timeoutMs: 300
    output: { select: "path" }`
    const client = await serve(tool, hangsOnce)
    const started = Date.now()
    const first = text(await client.callTool({ name: "slow_dns", arguments: {} }))
    expect(first).toMatch(/hang\.test.*timed out/)
    expect(Date.now() - started).toBeLessThan(3_000)
    const second = text(await client.callTool({ name: "slow_dns", arguments: {} }))
    expect(JSON.parse(second)).toBe("/echo")
  }, 15_000)

  it("turns POST into GET without a body on 303", async () => {
    const tool = `
  - name: see_other
    description: d
    http:
      method: POST
      url: "http://api.test:${port}/redirect-to?status=303&to=%2Fecho%2F303"
      followRedirects: 1
      body: { a: 1 }
    output: { select: "{method: method, body: body}" }`
    const client = await serve(tool, resolver)
    expect(JSON.parse(text(await client.callTool({ name: "see_other", arguments: {} })))).toEqual({
      method: "GET",
      body: null,
    })
  })
})
