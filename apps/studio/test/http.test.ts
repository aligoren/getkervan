import { createServer, request as httpRequest, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { serve } from "@hono/node-server"
import { afterEach, describe, expect, it } from "vitest"
import { clientIp } from "../src/client-ip.js"
import {
  allowedHostNames,
  bindHost,
  ConfigError,
  isSecure,
  loadConfig,
  parsePublicUrl,
} from "../src/config.js"
import { openDatabase } from "../src/db/open.js"
import { createStudioHttp } from "../src/http.js"
import { InMemorySecretStore } from "../src/secrets.js"
import { Studio } from "../src/studio.js"
import { recordingLogger, TEST_ONLY_NETWORK } from "./helpers.js"

const closers: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

describe("configuration", () => {
  it("defaults to loopback with a loopback public URL", () => {
    const config = loadConfig({}, "/srv")
    expect(config.publicUrl.origin).toBe("http://127.0.0.1:4310")
    expect(config.host).toBe("127.0.0.1")
    expect(config.trustProxy).toBe(0)
    expect(isSecure(config)).toBe(false)
  })

  it("requires a public URL off loopback", () => {
    expect(() => loadConfig({ KERVAN_STUDIO_HOST: "0.0.0.0" })).toThrow(/PUBLIC_URL is required/)
  })

  it.each([
    ["ftp://studio.example.com", /must start with https/],
    ["https://user:pass@studio.example.com", /credentials/],
    ["https://studio.example.com/studio", /origin only/],
    ["https://studio.example.com/?a=1", /origin only/],
    ["not a url", /not a valid URL/],
  ])("refuses the public URL %s", (raw, message) => {
    expect(() => parsePublicUrl(raw)).toThrow(message)
  })

  it("derives the secure flag and allowed hosts from the public URL", () => {
    const config = loadConfig({ KERVAN_STUDIO_PUBLIC_URL: "https://Studio.Example.com/" })
    expect(config.publicUrl.origin).toBe("https://studio.example.com")
    expect(isSecure(config)).toBe(true)
    expect(allowedHostNames(config)).toEqual(["studio.example.com"])
  })

  it.each([
    ["1", 1],
    ["false", 0],
    ["0", 0],
  ])("reads KERVAN_STUDIO_TRUST_PROXY=%s", (raw, hops) => {
    expect(loadConfig({ KERVAN_STUDIO_TRUST_PROXY: raw }).trustProxy).toBe(hops)
  })

  it.each(["true", "-1", "abc", "11"])("refuses KERVAN_STUDIO_TRUST_PROXY=%s", (raw) => {
    expect(() => loadConfig({ KERVAN_STUDIO_TRUST_PROXY: raw })).toThrow(ConfigError)
  })

  it("listens on loopback only until an admin exists", () => {
    expect(bindHost({ host: "0.0.0.0" }, false)).toBe("127.0.0.1")
    expect(bindHost({ host: "0.0.0.0" }, true)).toBe("0.0.0.0")
  })
})

describe("client IP", () => {
  it("ignores X-Forwarded-For unless proxies are trusted", () => {
    expect(clientIp("10.0.0.9", "1.2.3.4", 0)).toBe("10.0.0.9")
    expect(clientIp("::ffff:10.0.0.9", undefined, 0)).toBe("10.0.0.9")
  })

  it("takes the address the trusted proxy saw, not what the client wrote", () => {
    // The client sent "X-Forwarded-For: 6.6.6.6"; the proxy appended the real address.
    expect(clientIp("10.0.0.1", "6.6.6.6, 203.0.113.9", 1)).toBe("203.0.113.9")
    expect(clientIp("10.0.0.1", "6.6.6.6, 203.0.113.9, 10.0.0.2", 2)).toBe("203.0.113.9")
  })

  it("falls back to the socket for malformed or missing entries", () => {
    expect(clientIp("10.0.0.1", "not-an-ip", 1)).toBe("10.0.0.1")
    expect(clientIp("10.0.0.1", undefined, 1)).toBe("10.0.0.1")
  })
})

/** Studio's HTTP layer on a real socket, with the gateway behind it. */
async function startStudioHttp(options: {
  publicUrl: string
  trustProxy: number
  ipRateLimit: number
}) {
  const database = openDatabase(":memory:")
  const studio = new Studio({
    db: database.db,
    secrets: new InMemorySecretStore(),
    network: TEST_ONLY_NETWORK,
    allowedHosts: allowedHostNames({ publicUrl: new URL(options.publicUrl) }),
    logger: recordingLogger(),
  })
  const http = createStudioHttp(
    studio,
    { publicUrl: new URL(options.publicUrl), trustProxy: options.trustProxy },
    { ipRateLimit: options.ipRateLimit },
  )
  const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
    const listening = serve({ fetch: http.fetch, port: 0, hostname: "127.0.0.1" }, () =>
      resolve(listening),
    )
  })
  closers.push(async () => {
    await studio.close()
    await new Promise<void>((done) => {
      server.close(() => done())
      if ("closeAllConnections" in server) server.closeAllConnections()
    })
    database.close()
  })
  return (server.address() as AddressInfo).port
}

/**
 * A reverse proxy like nginx with `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`:
 * it keeps the Host header and appends the client's address. Each test client has its own
 * address, simulated with the `x-test-peer` header (all test sockets are 127.0.0.1).
 */
async function startProxy(targetPort: number): Promise<number> {
  const proxy: Server = createServer((req, res) => {
    const peer = String(req.headers["x-test-peer"] ?? "127.0.0.1")
    const incoming = req.headers["x-forwarded-for"]
    const forwarded = incoming ? `${incoming}, ${peer}` : peer
    const { "x-test-peer": _peer, ...headers } = req.headers
    const upstream = httpRequest(
      {
        host: "127.0.0.1",
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: { ...headers, "x-forwarded-for": forwarded },
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
      },
    )
    req.pipe(upstream)
  })
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  closers.push(
    () =>
      new Promise<void>((done) => {
        proxy.closeAllConnections()
        proxy.close(() => done())
      }),
  )
  return (proxy.address() as AddressInfo).port
}

function get(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/nothing-here", headers },
      (response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      },
    )
    req.on("error", reject)
    req.end()
  })
}

describe("Studio behind a reverse proxy", () => {
  const publicUrl = "https://studio.example.test"
  const host = { host: "studio.example.test" }

  it("limits each real client separately, whatever they put in X-Forwarded-For", async () => {
    const studio = await startStudioHttp({ publicUrl, trustProxy: 1, ipRateLimit: 2 })
    const proxy = await startProxy(studio)
    const alice = { ...host, "x-test-peer": "203.0.113.10" }
    const bob = { ...host, "x-test-peer": "203.0.113.20" }
    expect([await get(proxy, alice), await get(proxy, alice)]).toEqual([404, 404])
    expect(await get(proxy, alice)).toBe(429)
    // Alice cannot reset her budget by claiming another address.
    expect(await get(proxy, { ...alice, "x-forwarded-for": "198.51.100.77" })).toBe(429)
    // Bob has his own budget.
    expect(await get(proxy, bob)).toBe(404)
  })

  it("ignores X-Forwarded-For when no proxy is trusted", async () => {
    const studio = await startStudioHttp({ publicUrl, trustProxy: 0, ipRateLimit: 2 })
    expect(await get(studio, { ...host, "x-forwarded-for": "198.51.100.1" })).toBe(404)
    expect(await get(studio, { ...host, "x-forwarded-for": "198.51.100.2" })).toBe(404)
    expect(await get(studio, { ...host, "x-forwarded-for": "198.51.100.3" })).toBe(429)
  })

  it("accepts only the public host name in the Host header", async () => {
    const studio = await startStudioHttp({ publicUrl, trustProxy: 1, ipRateLimit: 100 })
    const proxy = await startProxy(studio)
    expect(await get(proxy, host)).toBe(404)
    expect(await get(proxy, { host: "studio.example.test:443" })).toBe(404)
    for (const bad of [
      "evil.test",
      "127.0.0.1",
      "evil.test@studio.example.test",
      "studio.example.test.evil.test",
    ]) {
      // Node itself answers 400 to a malformed Host; Studio answers 403 to a foreign one.
      expect([400, 403], bad).toContain(await get(proxy, { host: bad }))
    }
  })

  it("sets security headers on every response", async () => {
    const studio = await startStudioHttp({ publicUrl, trustProxy: 0, ipRateLimit: 100 })
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      httpRequest({ host: "127.0.0.1", port: studio, path: "/", headers: host }, (res) => {
        res.resume()
        resolve(res.headers)
      })
        .on("error", reject)
        .end()
    })
    expect(response).toMatchObject({
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    })
    expect(response).not.toHaveProperty("access-control-allow-origin")
  })
})
