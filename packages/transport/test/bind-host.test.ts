// Binding beyond loopback needs the host names clients use: without them there is no Host check,
// and any web page could reach the server through DNS rebinding. `serve()` takes the address from
// HOST, which environments often set for other reasons (container images, tcsh).
import { spawn } from "node:child_process"
import { request } from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createApp, silentLogger } from "@kervan/core"
import { afterEach, describe, expect, it } from "vitest"
import { type HttpServerHandle, serveHttp } from "../src/node.js"

const handles: HttpServerHandle[] = []
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close()
})

const app = () => createApp({ name: "bind", version: "0.0.0", logger: silentLogger })

function status(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/mcp",
        method: "POST",
        setHost: false,
        headers: {
          host,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
      },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on("error", reject)
    req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }))
  })
}

describe("serveHttp off loopback", () => {
  it("refuses to bind without allowedHosts", async () => {
    for (const host of ["0.0.0.0", "::", "192.0.2.10"]) {
      await expect(serveHttp(app(), { host, port: 0 })).rejects.toThrow(
        `Serving on ${host} needs allowedHosts`,
      )
    }
  })

  it("binds with allowedHosts, and refuses any other Host", async () => {
    const handle = await serveHttp(app(), {
      host: "0.0.0.0",
      port: 0,
      allowedHosts: ["mcp.example.test"],
    })
    handles.push(handle)
    expect(await status(handle.port, `mcp.example.test:${handle.port}`)).not.toBe(403)
    expect(await status(handle.port, `rebind.attacker.test:${handle.port}`)).toBe(403)
  })

  it("serve() with HOST=0.0.0.0 says why in one line and exits 1", async () => {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
    const script = `
      import { createApp } from "@kervan/core"
      import { serve } from "@kervan/transport/node"
      await serve(createApp({ name: "my-server", version: "0.1.0" }))
    `
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      cwd: dir,
      env: { ...process.env, KERVAN_TRANSPORT: "http", PORT: "0", HOST: "0.0.0.0" },
      stdio: ["ignore", "ignore", "pipe"],
    })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
    expect(code).toBe(1)
    expect(stderr).toContain("Cannot serve my-server: Serving on 0.0.0.0 needs allowedHosts")
    expect(stderr).not.toContain("listening on")
    expect(stderr).not.toMatch(/\n\s+at /)
  }, 20_000)
})
