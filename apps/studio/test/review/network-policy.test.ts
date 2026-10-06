// Security review (phase 4a): Studio's outbound address policy for spec tools (T3). These tests
// never open a connection to a non-local address: the deny list is checked with node:net's
// BlockList, and gateway calls resolve test names to 127.0.0.1 only.
import { mkdtempSync, rmSync } from "node:fs"
import { BlockList, isIP } from "node:net"
import os from "node:os"
import path from "node:path"
import { METADATA_RANGES } from "@kervan/spec-runtime"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { loadConfig } from "../../src/config.js"
import { studioNetworkPolicy } from "../../src/network.js"
import { startStudio } from "../../src/server.js"
import {
  connect,
  echoTool,
  publishedServer,
  resultText,
  spec,
  startTestStudio,
  startUpstream,
  type Upstream,
} from "../helpers.js"

let upstream: Upstream
beforeAll(async () => {
  upstream = await startUpstream()
})
afterAll(() => upstream.close())

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** The policy's deny list as a BlockList (exact, no network access). */
function denied(entries: readonly string[]): BlockList {
  const list = new BlockList()
  for (const entry of entries) {
    const [address = "", bits] = entry.split("/")
    const type = isIP(address) === 6 ? "ipv6" : "ipv4"
    if (bits === undefined) list.addAddress(address, type)
    else list.addSubnet(address, Number(bits), type)
  }
  return list
}

// Since 4b the runtime refuses cloud metadata itself, before any policy (no allowPrivate or
// deny list can change it), so the same protection also covers `kervan run`.
describe("review: cloud metadata endpoints are refused by the runtime", () => {
  const list = denied(METADATA_RANGES)

  it.each([
    ["AWS / GCP / Azure IMDS", "169.254.169.254", "ipv4"],
    ["AWS ECS task metadata", "169.254.170.2", "ipv4"],
    ["AWS IMDS over IPv6", "fd00:ec2::254", "ipv6"],
    ["Alibaba Cloud metadata", "100.100.100.200", "ipv4"],
    // A public address that answers only inside Azure VMs (WireServer: goal state, extension
    // settings, and a known SSRF target). The runtime classifies it as public unicast, so only an
    // explicit entry refuses it.
    ["Azure WireServer", "168.63.129.16", "ipv4"],
  ] as const)("refuses %s (%s)", (_name, address, family) => {
    expect(list.check(address, family)).toBe(true)
  })

  it("cannot be widened by Studio's policy", () => {
    const policy = studioNetworkPolicy({ allowPrivate: ["169.254.0.0/16"] } as never)
    expect(policy.allowPrivate).toBeUndefined()
    expect(Object.isFrozen(METADATA_RANGES)).toBe(true)
  })
})

describe("review: the policy cannot be widened", () => {
  it("drops allowPrivate whatever is passed in", () => {
    const policy = studioNetworkPolicy({ allowPrivate: ["0.0.0.0/0"] } as never)
    expect(policy.allowPrivate).toBeUndefined()
  })

  it("adds Studio's own addresses as exact ranges", () => {
    const list = denied(
      studioNetworkPolicy({ selfAddresses: ["203.0.113.5", "2001:db8::5"] }).denyList ?? [],
    )
    expect(list.check("203.0.113.5", "ipv4")).toBe(true)
    expect(list.check("2001:db8::5", "ipv6")).toBe(true)
    expect(list.check("203.0.113.6", "ipv4")).toBe(false)
  })
})

describe("review: deny list configuration", () => {
  it("rejects a malformed KERVAN_STUDIO_DENY_NETWORK entry when Studio starts", async () => {
    // Today the entry is accepted, Studio starts, and every spec tool call then fails with an
    // internal error (fail closed, but the operator is never told why).
    const dir = mkdtempSync(path.join(os.tmpdir(), "kervan-review-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const config = loadConfig({
      KERVAN_STUDIO_PORT: "0",
      KERVAN_STUDIO_DATA_DIR: dir,
      KERVAN_STUDIO_DENY_NETWORK: "10.0.0.0/8, internal.example.corp",
    })
    const started = await startStudio(config, {
      print: () => {},
      resolveSelf: async () => [],
    }).then(
      (running) => {
        cleanups.push(running.close)
        return true
      },
      () => false,
    )
    expect(started).toBe(false)
  })

  it("fails closed for tool calls when the deny list is malformed", async () => {
    const t = await startTestStudio({
      network: {
        denyList: ["not-an-address"],
        allowPrivate: ["127.0.0.1/32"],
        resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      },
    })
    cleanups.push(t.close)
    // Publishing does not contact the network, so it succeeds; the call must not go out.
    const s = await publishedServer(t, spec(echoTool(`http://up.test:${upstream.port}/echo/deny`)))
    const client = await connect(s.mcpUrl, s.key)
    cleanups.push(() => client.close())
    const result = await client.callTool({ name: "echo", arguments: {} })
    expect(result.isError).toBe(true)
    expect(resultText(result)).not.toContain("/echo/deny")
    expect(upstream.requests.filter((r) => r.path === "/echo/deny")).toEqual([])
  })
})
