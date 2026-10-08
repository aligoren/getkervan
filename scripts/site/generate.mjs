// Generates the data the website shows from real runs, into site/data/generated/:
//
// - example.json: what `kervan run examples/spec/kervan.yaml --http` answers to real MCP requests
//   (server/discover, tools/list, two tool calls). The calls reach the public Open-Meteo APIs, so
//   this needs the network; `--offline` keeps the recorded calls and refreshes the rest.
// - cli-help.json: the `--help` output of `kervan` and `kervan-studio`.
//
// The output is committed; `pnpm test` (scripts/test/site-data.test.ts) checks that it still
// matches the example spec and the commands, without the network. Run `pnpm build` first.
//
// Usage: node scripts/site/generate.mjs [--offline]
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const SPEC = "examples/spec/kervan.yaml"
const OUT = path.join(root, "site", "data", "generated")
const MODERN = "2026-07-28"

/** The spec as the site shows it (and its hash, to notice when it changes). */
export function specFingerprint(text) {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex")
}

/** `--help` output of a command (run with this Node.js, from the repository root). */
export function helpOf(script) {
  const result = spawnSync(process.execPath, [script, "--help"], { cwd: root, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`${script} --help failed: ${result.stderr}`)
  return result.stdout.replace(/\r\n/g, "\n").trimEnd()
}

export function cliHelp() {
  return {
    kervan: helpOf("packages/cli/bin/kervan.js"),
    "kervan-studio": helpOf("apps/studio/bin/kervan-studio.js"),
  }
}

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

let nextId = 1
/** A JSON-RPC request in the 2026-07-28 shape: `_meta` on every request, MCP headers. */
export function modernRequest(method, params = {}) {
  return {
    jsonrpc: "2.0",
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": MODERN,
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  }
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": MODERN,
      "mcp-method": body.method,
      ...(typeof body.params.name === "string" ? { "mcp-name": body.params.name } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  // A JSON body, or an event stream whose data lines hold the message.
  const json = text.trimStart().startsWith("{")
    ? JSON.parse(text)
    : JSON.parse(
        text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .at(-1) ?? "null",
      )
  if (!json || json.error) throw new Error(`${body.method} failed: ${text}`)
  return json.result
}

/** Starts `kervan run <spec> --http` and returns its MCP URL and a stop function. */
export async function startSpec(spec = SPEC) {
  const port = await freePort()
  const child = spawn(
    process.execPath,
    ["packages/cli/bin/kervan.js", "run", spec, "--http", "--port", String(port)],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] },
  )
  let output = ""
  child.stdout.on("data", (chunk) => (output += chunk))
  child.stderr.on("data", (chunk) => (output += chunk))
  const url = `http://127.0.0.1:${port}/mcp`
  for (let i = 0; i < 100; i++) {
    if (/listening|http:\/\/127\.0\.0\.1/i.test(output)) break
    if (child.exitCode !== null) throw new Error(`kervan run exited: ${output}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return {
    url,
    output: () => output,
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", resolve)
        child.kill()
      }),
  }
}

/** The answers that need no network: discovery and the tool list. */
export async function offlineAnswers(url) {
  const discover = modernRequest("server/discover")
  const list = modernRequest("tools/list")
  return {
    discover: { request: discover, result: await post(url, discover) },
    toolsList: { request: list, result: await post(url, list) },
  }
}

async function main() {
  const offline = process.argv.includes("--offline")
  const yaml = readFileSync(path.join(root, SPEC), "utf8")
  const previous = (() => {
    try {
      return JSON.parse(readFileSync(path.join(OUT, "example.json"), "utf8"))
    } catch {
      return undefined
    }
  })()

  const server = await startSpec()
  try {
    nextId = 1
    const answers = await offlineAnswers(server.url)
    let calls = previous?.calls
    let capturedAt = previous?.callsCapturedAt
    if (!offline) {
      const search = modernRequest("tools/call", {
        name: "search_city",
        arguments: { name: "Ankara" },
      })
      const weather = modernRequest("tools/call", {
        name: "get_current_weather",
        arguments: { latitude: 39.92, longitude: 32.85 },
      })
      calls = [
        { request: search, result: await post(server.url, search) },
        { request: weather, result: await post(server.url, weather) },
      ]
      capturedAt = new Date().toISOString()
    }
    if (!calls) throw new Error("No recorded calls yet: run once without --offline.")
    const example = {
      spec: SPEC,
      specSha256: specFingerprint(yaml),
      protocolVersion: MODERN,
      ...answers,
      calls,
      callsCapturedAt: capturedAt,
    }
    writeFileSync(path.join(OUT, "example.json"), `${JSON.stringify(example, null, 2)}\n`)
  } finally {
    await server.stop()
  }
  writeFileSync(path.join(OUT, "cli-help.json"), `${JSON.stringify(cliHelp(), null, 2)}\n`)
  console.log(`Wrote ${path.relative(root, OUT)}/example.json and cli-help.json`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
