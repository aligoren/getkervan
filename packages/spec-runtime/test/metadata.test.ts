import { createApp, silentLogger } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"
import type { Client } from "@modelcontextprotocol/client"
import ipaddr from "ipaddr.js"
import { afterEach, describe, expect, it } from "vitest"
import { applySpec, loadSpec, METADATA_RANGES } from "../src/index.js"
import { checkAddress } from "../src/network.js"

const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

const METADATA = [
  ["AWS, GCP, Azure, Oracle, DigitalOcean IMDS", "169.254.169.254"],
  ["ECS task credentials", "169.254.170.2"],
  ["EKS pod identity", "169.254.170.23"],
  ["Tencent Cloud", "169.254.0.23"],
  ["AWS IMDS over IPv6", "fd00:ec2::254"],
  ["Alibaba Cloud", "100.100.100.200"],
  ["Azure WireServer (a public address)", "168.63.129.16"],
  ["Oracle Cloud (legacy)", "192.0.0.192"],
  ["Azure WireServer, IPv4-mapped", "::ffff:168.63.129.16"],
] as const

describe("cloud metadata is refused by default", () => {
  it.each(METADATA)("refuses %s (%s)", (_name, address) => {
    expect(checkAddress(address)).toMatchObject({ allowed: false })
  })

  it.each(METADATA)("refuses %s (%s) even when every address is allowed", (_name, address) => {
    const allowEverything = {
      allow: [ipaddr.parseCIDR("0.0.0.0/0"), ipaddr.parseCIDR("::/0")],
    }
    expect(checkAddress(address, allowEverything)).toEqual({
      allowed: false,
      reason: "cloud metadata address",
    })
  })

  it("publishes the ranges it refuses", () => {
    expect(METADATA_RANGES).toEqual(
      expect.arrayContaining(["169.254.0.0/16", "168.63.129.16/32", "fd00:ec2::/32"]),
    )
    expect(Object.isFrozen(METADATA_RANGES)).toBe(true)
  })

  it("refuses a spec tool call to a name that resolves to metadata, with allowPrivate for all", async () => {
    const loaded = await loadSpec(
      `specVersion: 1
name: meta
version: 0.0.0
tools:
  - name: wire
    description: d
    http: { url: "https://metadata.example/machine?comp=goalstate" }
    output: { raw: true }`,
      {
        secrets: { get: () => undefined },
        network: {
          allowPrivate: ["0.0.0.0/0", "::/0"],
          resolve: async () => [{ address: "168.63.129.16", family: 4 }],
        },
      },
    )
    const app = createApp({ name: "meta", version: "0", logger: silentLogger })
    applySpec(app.registry, loaded)
    const client = await createTestClient(app)
    clients.push(client)
    const result = await client.callTool({ name: "wire", arguments: {} })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain(
      "it resolves to a disallowed address (cloud metadata address)",
    )
  })
})
