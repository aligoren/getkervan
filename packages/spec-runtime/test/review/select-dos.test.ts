// Security review (release): the cost of a spec's `select` expression.
//
// `select` is limited to 1,000 characters, but not in what it may compute: the community JMESPath
// edition has functions that build data out of nothing (`pad_left(s, width)` makes a string of any
// width, `split(s, '')` turns it into an array) and `map` nests, so a few dozen characters could
// allocate gigabytes or run for minutes, synchronously. In Studio a member could trigger that from
// the playground. Expressions run in a separate process (select.ts): a runaway one is stopped
// after the tool's timeout or when it runs out of memory, and this process keeps serving.
//
// Each case runs in a child process (built `dist`, a local upstream on 127.0.0.1) so a crash or a
// stall cannot take the test runner down with it.
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..")
const dist = (pkg: string, file = "index.js") =>
  pathToFileURL(path.join(repo, "packages", pkg, "dist", file)).href

let dir: string
let script: string
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kervan-review-select-"))
  script = path.join(dir, "child.mjs")
  await writeFile(
    script,
    `
import { createServer } from "node:http"
import { createApp, silentLogger } from ${JSON.stringify(dist("core"))}
import { applySpec, loadSpec } from ${JSON.stringify(dist("spec-runtime"))}
import { createTestClient } from ${JSON.stringify(dist("transport", "testing.js"))}

const select = process.argv[2]
const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "application/json" })
  res.end("{}")
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const { port } = server.address()
const loaded = await loadSpec(
  \`specVersion: 1
name: review
version: 0.0.0
tools:
  - name: pick
    description: Picks a field
    http:
      url: http://127.0.0.1:\${port}/
      allowInsecureHttp: true
      timeoutMs: 1000
    output: { select: \${JSON.stringify(select)} }\`,
  { network: { allowPrivate: ["127.0.0.1/32"] } },
)
const app = createApp({ name: "review", version: "0.0.0", logger: silentLogger })
applySpec(app.registry, loaded)
const client = await createTestClient(app)

// Event-loop lag: how long the process could not serve anything else.
let maxLag = 0
let last = performance.now()
const tick = setInterval(() => {
  const now = performance.now()
  maxLag = Math.max(maxLag, now - last - 20)
  last = now
}, 20)
const started = performance.now()
const result = await client.callTool({ name: "pick", arguments: {} })
const duration = Math.round(performance.now() - started)
// Let the interval fire once more, so a block that just ended is measured.
await new Promise((resolve) => setTimeout(resolve, 60))
clearInterval(tick)
console.log(JSON.stringify({ survived: true, duration, maxLag: Math.round(maxLag), isError: result.isError === true }))
await client.close()
server.close()
process.exit(0)
`,
  )
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function runChild(select: string, heapMb?: number) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const flags = heapMb === undefined ? [] : [`--max-old-space-size=${heapMb}`]
    const child = spawn(process.execPath, [...flags, script, select], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString()
    })
    child.stderr.on("data", () => {})
    const killer = setTimeout(() => child.kill("SIGKILL"), 90_000)
    child.on("exit", (code) => {
      clearTimeout(killer)
      resolve({ code, out })
    })
  })
}

/** An array of n one-character strings, made from nothing. */
const made = (n: number) => `split(pad_left('a', \`${n}\`), '')`

describe("review-gw: a select expression cannot exhaust the process", () => {
  it("does not crash the process with a 34-character expression (heap exhaustion)", async () => {
    // length() of a string spreads it into an array of code points.
    const select = "length(pad_left('a', `500000000`))"
    expect(select.length).toBe(34)
    // V8's default heap: the array is over V8's own length limit, so any heap size aborts.
    const { code, out } = await runChild(select)
    // The call fails and the process carries on.
    expect(code).toBe(0)
    expect(out).toContain('"survived":true')
  }, 120_000)

  it("does not hold the event loop longer than the tool's own timeout (CPU)", async () => {
    // 1,000 x 1,000 x 1,000 evaluations; every intermediate array is small.
    const select = `length(map(&length(map(&length(map(&\`1\`, ${made(1000)})), ${made(1000)})), ${made(1000)}))`
    expect(select.length).toBeLessThan(200)
    const { code, out } = await runChild(select, 1024)
    expect(code).toBe(0)
    const report = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as {
      maxLag?: number
      duration?: number
    }
    // timeoutMs is 1,000 ms; the core adds 5 s headroom. Neither the call nor a block of the
    // event loop should last longer than that.
    expect(report.duration).toBeLessThan(6_000)
    expect(report.maxLag).toBeLessThan(6_000)
  }, 120_000)
})
