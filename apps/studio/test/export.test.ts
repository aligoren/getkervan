import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createWorkspace } from "../src/db/repos/workspaces.js"
import { ExportError, exportSpec } from "../src/export.js"
import {
  connect,
  resultText,
  spec,
  startTestStudio,
  startUpstream,
  type Upstream,
  user,
} from "./helpers.js"

const SECRET = "sk-export-0123456789abcdef"
const kervanBin = fileURLToPath(new URL("../../../packages/cli/bin/kervan.js", import.meta.url))

let upstream: Upstream
beforeAll(async () => {
  upstream = await startUpstream()
})
afterAll(() => upstream.close())

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const binding = (name: string, allowedHosts: string[]) => ({ name, allowedHosts, updatedAt: 0 })

describe("exportSpec", () => {
  const text = (secrets: string) => `# My server
specVersion: 1
name: s
version: 1.0.0
secrets: ${secrets} # keep me
tools: []
`

  it("writes Studio's bindings for an unbound secret, keeping comments", () => {
    const out = exportSpec(text("[API_KEY]"), [binding("API_KEY", ["api.example.com"])])
    expect(out).toContain("# My server")
    expect(out).toBe(text('[{ name: API_KEY, hosts: ["api.example.com"] }]'))
  })

  it("narrows a spec binding to the hosts Studio allows, never widens it", () => {
    const narrowed = exportSpec(
      text("[{ name: API_KEY, hosts: [a.example.com, b.example.com] }]"),
      [binding("API_KEY", ["b.example.com", "c.example.com"])],
    )
    expect(narrowed).toContain('hosts: ["b.example.com"]')
    expect(narrowed).not.toContain("c.example.com")
    expect(narrowed).not.toContain("a.example.com")
  })

  it("changes only the secret entries, keeping the rest byte for byte", () => {
    const source = `# Top comment
specVersion: 1
name: s
version: 1.0.0
description: A long description that a YAML printer would happily fold onto the next line for us
secrets:
  - API_KEY   # bound by Studio
  - name: OTHER_KEY
    hosts: [a.example.com, "[2001:db8::1]"]
  - THIRD
tools: [] # none yet
`
    const out = exportSpec(source, [
      binding("API_KEY", ["api.example.com"]),
      binding("OTHER_KEY", ["[2001:db8::1]"]),
    ])
    expect(out).toBe(
      source
        .replace("- API_KEY ", '- { name: API_KEY, hosts: ["api.example.com"] } ')
        .replace(
          '- name: OTHER_KEY\n    hosts: [a.example.com, "[2001:db8::1]"]',
          '- { name: OTHER_KEY, hosts: ["[2001:db8::1]"] }',
        ),
    )
  })

  it("refuses when no host is left", () => {
    expect(() =>
      exportSpec(text("[{ name: API_KEY, hosts: [a.example.com] }]"), [
        binding("API_KEY", ["b.example.com"]),
      ]),
    ).toThrow(ExportError)
  })

  it("leaves secrets Studio does not hold, and specs without secrets, as written", () => {
    expect(exportSpec(text("[OTHER]"), [binding("API_KEY", ["x.example.com"])])).toBe(
      text("[OTHER]"),
    )
    const plain = "specVersion: 1\nname: s\nversion: 1.0.0\ntools: []\n"
    expect(exportSpec(plain, [])).toBe(plain)
  })
})

describe("an exported version runs with kervan run", () => {
  function tempDir(): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "kervan-studio-export-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    return dir
  }

  const yamlFor = (url: string) =>
    spec(
      `
  - name: keyed
    description: Sends the key
    http:
      url: ${url}
      headers: { X-Key: "{{secrets.API_KEY}}" }
    output: { select: "{path: path, key: key}" }`,
      "secrets: [API_KEY]",
    )

  it("behaves like the gateway: same result, same binding", async () => {
    const t = await startTestStudio()
    cleanups.push(t.close)
    const scope = createWorkspace(t.database.db, "w")
    const server = t.studio.createServer(scope, { slug: "s", name: "S" }, user())
    t.secrets.set(scope, server.id, {
      name: "API_KEY",
      value: SECRET,
      allowedHosts: ["127.0.0.1"],
    })
    const version = t.studio.saveVersion(
      scope,
      server.id,
      yamlFor(`${upstream.url}/echo/x`),
      user(),
    )
    await t.studio.publish(scope, server.id, version.id, user())
    const { key } = t.studio.createApiKey(scope, server.id, "k", user())

    const gatewayClient = await connect(new URL(`/s/${server.id}/mcp`, t.url), key)
    cleanups.push(() => gatewayClient.close())
    const viaGateway = resultText(await gatewayClient.callTool({ name: "keyed", arguments: {} }))

    const exported = await t.studio.exportVersion(scope, server.id, version.id)
    expect(exported).toContain('{ name: API_KEY, hosts: ["127.0.0.1"] }')
    expect(exported).not.toContain(SECRET)
    const dir = tempDir()
    const file = path.join(dir, "kervan.yaml")
    writeFileSync(file, exported)

    // The test API is on loopback, which kervan run only reaches with this development flag.
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [kervanBin, "run", file, "--allow-private-network"],
      env: { ...process.env, API_KEY: SECRET, NODE_ENV: "test" } as Record<string, string>,
      stderr: "pipe",
    })
    const cliClient = new Client({ name: "export-test", version: "0.0.0" })
    await cliClient.connect(transport)
    cleanups.push(() => cliClient.close())
    const viaCli = resultText(await cliClient.callTool({ name: "keyed", arguments: {} }))

    expect(JSON.parse(viaCli)).toEqual(JSON.parse(viaGateway))
    expect(JSON.parse(viaCli)).toEqual({ path: "/echo/x", key: "[redacted]" })
  })

  it("keeps refusing other hosts after export", () => {
    const exported = exportSpec(yamlFor("http://127.0.0.1:9/echo"), [
      binding("API_KEY", ["127.0.0.1"]),
    ])
    // Someone edits the exported file to send the key elsewhere.
    const tampered = exported.replace("http://127.0.0.1:9/echo", "https://attacker.example.net/")
    const dir = tempDir()
    const file = path.join(dir, "kervan.yaml")
    writeFileSync(file, tampered)
    const result = spawnSync(process.execPath, [kervanBin, "run", file], {
      env: { ...process.env, API_KEY: SECRET },
      encoding: "utf8",
      input: "",
      timeout: 30_000,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      "Secret API_KEY may only be sent to 127.0.0.1; this tool calls attacker.example.net.",
    )
    expect(result.stderr).not.toContain(SECRET)
  })
})
