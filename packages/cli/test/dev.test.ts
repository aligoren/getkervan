import { afterEach, describe, expect, it } from "vitest"
import { currentRuntime, windowsLibuvWarning } from "../src/node-version.js"
import {
  connectDev,
  type DevSession,
  isAlive,
  makeProject,
  type Project,
  SECRET,
  serverSource,
  spawnDev,
  textOf,
} from "./dev-helpers.js"

const POLL = { timeout: 15_000, interval: 50 }
const sessions: DevSession[] = []
const projects: Project[] = []

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => {})))
  await Promise.all(projects.splice(0).map((project) => project.cleanup()))
})

async function setup(era: "legacy" | "modern", args: string[] = [], env = {}) {
  const project = await makeProject()
  projects.push(project)
  const session = await connectDev(project, era, args, env)
  sessions.push(session)
  return { project, session, client: session.client }
}

const callText = async (session: DevSession, name: string, args: Record<string, unknown> = {}) =>
  textOf(await session.client.callTool({ name, arguments: args }))

describe.each(["legacy", "modern"] as const)("kervan dev --stdio (%s era)", (era) => {
  it("serves the server's tools through the dev host", { timeout: 30_000 }, async () => {
    const { client, session } = await setup(era)
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual([
      "version",
      "pid",
      "slow",
      "install_extra",
      "leak",
    ])
    expect(await callText(session, "version")).toBe("v1")
    const invalid = await client.callTool({ name: "slow", arguments: { ms: "soon" } })
    expect(invalid.isError).toBe(true)
  })

  it("reloads on save (CRLF file) and notifies only when tools change", {
    timeout: 30_000,
  }, async () => {
    const { project, session } = await setup(era)

    // Same tools, new behavior: the code reloads but the tool list is identical.
    await project.write(serverSource("v2", "", "\r\n"))
    await expect.poll(() => callText(session, "version"), POLL).toBe("v2")
    expect(session.notifications()).toBe(0)

    // A new tool: clients get list_changed.
    const extra = `app.tool("added", { description: "New in v3", handler: () => "added!" })`
    await project.write(serverSource("v3", extra, "\r\n"))
    await expect.poll(session.notifications, POLL).toBe(1)
    const { tools } = await session.client.listTools()
    expect(tools.map((tool) => tool.name)).toContain("added")
    expect(await callText(session, "added")).toBe("added!")
    expect(await callText(session, "version")).toBe("v3")
  })

  it("keeps the last good version while the code does not start", { timeout: 30_000 }, async () => {
    const { project, session } = await setup(era)
    await project.write(`${serverSource("v2")}\nconst broken = ;\n`)
    await expect.poll(session.stderr, POLL).toMatch(/Could not start the server/)
    expect(await callText(session, "version")).toBe("v1")

    await project.write(serverSource("v3"))
    await expect.poll(() => callText(session, "version"), POLL).toBe("v3")
  })

  it("follows the server's own list_changed", { timeout: 30_000 }, async () => {
    const { session, client } = await setup(era)
    await callText(session, "install_extra")
    await expect.poll(session.notifications, POLL).toBe(1)
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("extra")
    expect(await callText(session, "extra")).toBe("extra!")
  })
})

describe("reload draining", () => {
  it("lets a running call finish on the old code", { timeout: 30_000 }, async () => {
    const { project, session } = await setup("legacy")
    const slow = callText(session, "slow", { ms: 2_000 })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await project.write(serverSource("v2"))
    await expect.poll(() => callText(session, "version"), POLL).toBe("v2")
    expect(await slow).toBe("v1")
    expect(session.stderr()).toMatch(/Waiting for 1 call\(s\) on the previous version/)
  })

  it("interrupts calls that outlive the drain timeout", { timeout: 30_000 }, async () => {
    const { project, session } = await setup("legacy", ["--drain-timeout", "300"])
    const slow = session.client.callTool({ name: "slow", arguments: { ms: 8_000 } })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await project.write(serverSource("v2"))
    const result = await slow
    expect(result.isError).toBe(true)
    expect(textOf(result)).toMatch(/interrupted because the server reloaded/)
    expect(await callText(session, "version")).toBe("v2")
  })
})

describe("secrets", () => {
  it("never prints environment secrets from tool errors or server logs", {
    timeout: 30_000,
  }, async () => {
    const { session } = await setup("legacy", [], { KERVAN_TEST_API_KEY: SECRET })
    const result = await session.client.callTool({ name: "leak", arguments: {} })
    expect(result.isError).toBe(true)
    expect(textOf(result)).toBe("auth failed for key [redacted]")
    await expect.poll(session.stderr, POLL).toMatch(/connecting with \[redacted\]/)
    expect(session.stderr()).not.toContain(SECRET)
  })
})

describe("shutdown", () => {
  it("stops the server process when the client disconnects", { timeout: 30_000 }, async () => {
    const { session } = await setup("legacy")
    const pid = Number(await callText(session, "pid"))
    expect(isAlive(pid)).toBe(true)
    await session.close()
    await expect.poll(() => isAlive(pid), POLL).toBe(false)
  })
})

describe("kervan dev --http", () => {
  async function startHttp(args: string[] = []) {
    const project = await makeProject()
    projects.push(project)
    const dev = spawnDev(project, ["--http", "--port", "0", ...args])
    await expect.poll(dev.stdout, POLL).toMatch(/Kervan dev server: (http:\S+)/)
    const url = new URL(/Kervan dev server: (http:\S+)/.exec(dev.stdout())?.[1] ?? "")
    return { dev, url }
  }

  const listRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  }

  async function post(url: URL, headers: Record<string, string>) {
    const { request } = await import("node:http")
    return new Promise<number>((resolve, reject) => {
      const req = request(
        url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "tools/list",
            ...headers,
          },
        },
        (res) => {
          res.resume()
          res.on("end", () => resolve(res.statusCode ?? 0))
        },
      )
      req.on("error", reject)
      req.end(JSON.stringify(listRequest))
    })
  }

  it("binds to 127.0.0.1 and keeps DNS rebinding protection", { timeout: 30_000 }, async () => {
    const { dev, url } = await startHttp(["--no-repl"])
    try {
      expect(url.hostname).toBe("127.0.0.1")
      expect(await post(url, {})).toBe(200)
      expect(await post(url, { host: "evil.example" })).toBe(403)
      expect(
        await post(url, { host: `localhost:${url.port}`, origin: "https://evil.example" }),
      ).toBe(403)
      expect(await post(url, { origin: "http://localhost:5173" })).toBe(200)
    } finally {
      dev.child.stdin?.end()
      dev.child.kill()
      await dev.exited
    }
  })

  it("runs REPL commands from stdin", { timeout: 30_000 }, async () => {
    const { dev } = await startHttp(["--repl"])
    dev.child.stdin?.end(
      [
        "tools",
        'call slow {"ms":10}',
        'call slow {"ms":"x"}',
        "call version {nope",
        "exit",
        "",
      ].join("\n"),
    )
    expect(await dev.exited).toBe(0)
    const out = dev.stdout()
    expect(out).toMatch(/version {2}Returns the code version/)
    expect(out).toMatch(/^v1$/m)
    expect(out).toMatch(/error: Input validation error/)
    expect(out).toMatch(/Arguments must be JSON/)
  })
})

describe("preflight", () => {
  it("refuses NODE_ENV=production", { timeout: 30_000 }, async () => {
    const project = await makeProject()
    projects.push(project)
    const dev = spawnDev(project, ["--stdio"], { NODE_ENV: "production" })
    expect(await dev.exited).toBe(1)
    expect(dev.stderr()).toMatch(/refuses to run with NODE_ENV=production/)
  })

  it("warns about Node 24 before 24.21 on Windows when that is what runs", {
    timeout: 30_000,
  }, async () => {
    const project = await makeProject()
    projects.push(project)
    const dev = spawnDev(project, ["--stdio", "--no-watch"])
    dev.child.stdin?.end()
    await dev.exited
    const expected = windowsLibuvWarning(currentRuntime())
    if (expected) expect(dev.stderr()).toContain(expected)
    else expect(dev.stderr()).not.toMatch(/libuv bug/)
  })
})
