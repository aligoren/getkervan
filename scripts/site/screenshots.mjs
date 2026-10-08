// `pnpm site:screenshots`: photographs Kervan Studio for the website.
//
// 1. Starts the built Studio (`pnpm build` first) with a throwaway data directory (in the system's
//    temp folder, deleted at the end), a random master key, and a public URL on a reserved
//    example domain (studio.example.test, resolved to 127.0.0.1 only inside the browser).
// 2. Seeds demo data through Studio's own API: example.test accounts, three servers, versions,
//    secrets with made-up values, API keys, and real calls of the example spec through the gateway
//    (they reach the public Open-Meteo APIs: this needs the network).
// 3. Captures each screen at 1440x900 (and some at 390x844) in light and dark, after checking the
//    page's text for anything that must not be published (scripts/site/leaks.mjs): any finding
//    stops the run. API keys shown once by Studio are replaced in the page, before that check, by
//    an obviously fake placeholder.
// 4. Converts each capture to WebP in the browser (no image library) and writes
//    site/assets/screenshots/<name>-<theme>.webp.
//
// Nothing in Studio is changed for this: it is driven as a user would.
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { assertNoLeaks, machineSecrets } from "./leaks.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..")
const OUT = path.join(root, "site", "assets", "screenshots")
const HOST = "studio.example.test"
const WIDE = { width: 1440, height: 900 }
const NARROW = { width: 390, height: 844 }
const CLIENT_IP = "203.0.113.24"
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36"
const FAKE_KEY = "kvn_EXAMPLE-KEY-shown-once-in-Studio"
/** Made-up passwords for made-up accounts; never published (the page never shows them). */
const PASSWORD = `demo-${randomBytes(9).toString("base64url")}`

const require = createRequire(path.join(root, "package.json"))
const { chromium } = require("@playwright/test")

function freePort() {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once("error", () => resolve(false))
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)))
  })
}

/** Starts the built Studio; resolves once it listens, with its setup token. */
async function startStudio(port, dataDir, masterKey) {
  const child = spawn(
    process.execPath,
    [path.join(root, "apps/studio/bin/kervan-studio.js"), "start"],
    {
      cwd: dataDir,
      env: {
        PATH: process.env.PATH,
        SYSTEMROOT: process.env.SYSTEMROOT,
        KERVAN_STUDIO_PUBLIC_URL: `http://${HOST}:${port}`,
        KERVAN_STUDIO_PORT: String(port),
        KERVAN_STUDIO_DATA_DIR: path.join(dataDir, "data"),
        KERVAN_STUDIO_MASTER_KEY: masterKey,
        // Demo clients appear with documentation addresses (203.0.113.0/24).
        KERVAN_STUDIO_TRUST_PROXY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
  let output = ""
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Studio did not start:\n${output}`)), 30_000)
    const read = (chunk) => {
      output += chunk
      const found = /one-time token[^\n]*\n\s+(\S+)/.exec(output)?.[1]
      if (found && output.includes("listening on")) {
        clearTimeout(timer)
        resolve(found)
      }
    }
    child.stdout.on("data", read)
    child.stderr.on("data", read)
    child.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`Studio exited (${code}):\n${output}`))
    })
  })
  return {
    token,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once("exit", resolve)
        child.kill()
      }),
  }
}

/** An HTTP client for Studio's API as a browser on its public origin would call it. */
function apiClient(port) {
  const origin = `http://${HOST}:${port}`
  let cookie = ""
  let csrf = ""
  const call = (method, pathname, body, headers = {}) =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method,
          path: pathname,
          headers: {
            host: `${HOST}:${port}`,
            "x-forwarded-for": CLIENT_IP,
            "user-agent": USER_AGENT,
            ...(method === "GET" ? {} : { origin, "content-type": "application/json" }),
            ...(cookie ? { cookie } : {}),
            ...(csrf && method !== "GET" ? { "x-csrf-token": csrf } : {}),
            ...headers,
          },
        },
        (response) => {
          let text = ""
          response.on("data", (chunk) => (text += chunk))
          response.on("end", () => {
            const setCookie = response.headers["set-cookie"]?.[0]
            if (setCookie) cookie = setCookie.split(";")[0]
            let json
            try {
              json = JSON.parse(text)
            } catch {
              json = text
            }
            if ((response.statusCode ?? 500) >= 400 && !headers["x-allow-error"]) {
              reject(new Error(`${method} ${pathname}: ${response.statusCode} ${text}`))
            } else resolve(json)
          })
        },
      )
      req.on("error", reject)
      req.end(payload)
    })
  return {
    call,
    signIn: async (email, password) => {
      const result = await call("POST", "/api/login", { email, password })
      csrf = result.csrfToken
    },
    setup: async (token, email, password) => {
      const result = await call("POST", "/api/setup", { token, email, password })
      csrf = result.csrfToken
    },
  }
}

/** A raw MCP call through the gateway with an API key (2026-07-28 request shape). */
function gatewayCall(port, serverId, key, method, params = {}) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params: {
      ...params,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  })
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: `/s/${serverId}/mcp`,
        headers: {
          host: `${HOST}:${port}`,
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(params.name ? { "mcp-name": params.name } : {}),
          "x-forwarded-for": "198.51.100.7",
        },
      },
      (response) => {
        response.resume()
        response.on("end", resolve)
      },
    )
    req.on("error", reject)
    req.end(body)
  })
}

const specOf = (file) => readFileSync(path.join(root, file), "utf8")

const ISSUES_SPEC = `specVersion: 1
name: issue-tracker
version: 1.2.0
description: Read-only access to the team's issue tracker.
secrets:
  - name: ISSUES_TOKEN
    hosts: [api.issues.example.com]
tools:
  - name: list_open_issues
    title: Open issues
    description: The 20 most recently updated open issues of a project.
    annotations: { readOnlyHint: true }
    input:
      type: object
      properties:
        project: { type: string, pattern: "^[a-z0-9-]{1,40}$" }
      required: [project]
    http:
      url: https://api.issues.example.com/v2/projects/{{input.project}}/issues
      query: { state: open, per_page: 20 }
      headers: { Authorization: "Bearer {{secrets.ISSUES_TOKEN}}" }
    output:
      select: "items[].{id: id, title: title, updated: updated_at}"
`

const STATUS_SPEC = `specVersion: 1
name: status-page
version: 0.1.0
description: Current status of the public services.
tools:
  - name: current_status
    title: Service status
    description: The overall status and any open incidents.
    annotations: { readOnlyHint: true }
    input: { type: object, properties: {} }
    http:
      url: https://status.example.com/api/v2/summary.json
    output:
      select: "{status: status.description, incidents: incidents[].name}"
`

async function seed(port, token) {
  const admin = apiClient(port)
  await admin.setup(token, "ops@example.test", PASSWORD)
  await admin.call("PUT", "/api/profile", { displayName: "Ops Team" })
  for (const [email, role] of [
    ["maya@example.test", "member"],
    ["kerem@example.test", "member"],
    ["ana@example.test", "admin"],
  ]) {
    await admin.call("POST", "/api/users", {
      email,
      password: PASSWORD,
      role,
      adminPassword: PASSWORD,
    })
  }

  const server = async (slug, name) =>
    (await admin.call("POST", "/api/servers", { slug, name })).server.id
  const save = async (id, yaml) =>
    (await admin.call("POST", `/api/servers/${id}/versions`, { yaml })).version.id
  const publish = (id, versionId) =>
    admin.call("POST", `/api/servers/${id}/versions/${versionId}/publish`, {})

  const weather = await server("weather", "Weather")
  const full = specOf("examples/spec/kervan.yaml")
  // v1: the city search only; v2: the whole example. v1 is published again (a rollback), then v2.
  const first = full.slice(0, full.indexOf("  - name: get_current_weather"))
  const v1 = await save(weather, first)
  await publish(weather, v1)
  const v2 = await save(weather, full)
  await publish(weather, v2)
  await publish(weather, v1)
  await publish(weather, v2)
  await admin.call("PUT", `/api/servers/${weather}/settings`, { logPayloads: true })

  const issues = await server("issues", "Issue tracker")
  await admin.call("PUT", `/api/servers/${issues}/secrets/ISSUES_TOKEN`, {
    value: "demo-value-not-a-real-token-1234",
    allowedHosts: ["api.issues.example.com"],
  })
  await admin.call("PUT", `/api/servers/${issues}/secrets/WEBHOOK_SIGNING_KEY`, {
    value: "demo-value-not-a-real-key-5678",
    allowedHosts: ["hooks.issues.example.com"],
  })
  await publish(issues, await save(issues, ISSUES_SPEC))

  const status = await server("status", "Status page")
  await save(status, STATUS_SPEC)

  const keys = []
  for (const [id, name] of [
    [weather, "Claude Code (laptop)"],
    [weather, "Nightly smoke test"],
    [issues, "CI"],
  ]) {
    keys.push((await admin.call("POST", `/api/servers/${id}/keys`, { name })).key)
  }
  // Real calls through the gateway: they reach the public Open-Meteo APIs.
  const key = keys[0]
  await gatewayCall(port, weather, key, "tools/list")
  await gatewayCall(port, weather, key, "tools/call", {
    name: "search_city",
    arguments: { name: "Ankara" },
  })
  await gatewayCall(port, weather, key, "tools/call", {
    name: "get_current_weather",
    arguments: { latitude: 39.92, longitude: 32.85 },
  })
  await gatewayCall(port, weather, key, "tools/call", {
    name: "search_city",
    arguments: { name: "Izmir" },
  })
  await gatewayCall(port, weather, key, "tools/call", {
    name: "get_current_weather",
    arguments: { latitude: 38.42, longitude: 27.14 },
  })
  // Refused by the input schema: the model gets an error it can fix.
  await gatewayCall(port, weather, key, "tools/call", {
    name: "get_current_weather",
    arguments: { latitude: 120, longitude: 27.14 },
  })

  // A member's activity for the audit log.
  const maya = apiClient(port)
  await maya.signIn("maya@example.test", PASSWORD)
  await maya.call("POST", `/api/servers/${status}/versions`, {
    yaml: STATUS_SPEC.replace("0.1.0", "0.1.1"),
  })
  const kerem = (await admin.call("GET", "/api/users")).users.find(
    (u) => u.email === "kerem@example.test",
  )
  await admin.call("PUT", `/api/users/${kerem.id}`, { disabled: true })
  return { weather, issues, status, keys, admin }
}

/** Replaces every real API key in the page with the placeholder (text and form fields). */
async function hideKeys(page) {
  await page.evaluate((fake) => {
    const pattern = /kvn_[A-Za-z0-9_-]{40,}/g
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (pattern.test(node.nodeValue ?? ""))
        node.nodeValue = (node.nodeValue ?? "").replace(pattern, fake)
    }
    for (const field of document.querySelectorAll("input, textarea")) {
      if (pattern.test(field.value)) field.value = field.value.replace(pattern, fake)
    }
  }, FAKE_KEY)
}

/** Everything a viewer of the picture could read: text, field values, titles and alt texts. */
function visibleText(page) {
  return page.evaluate(() => {
    const parts = [document.body.innerText, document.title]
    for (const field of document.querySelectorAll("input, textarea, select"))
      parts.push(field.value)
    for (const element of document.querySelectorAll("[title], [alt], [aria-label]")) {
      parts.push(
        element.getAttribute("title") ?? "",
        element.getAttribute("alt") ?? "",
        element.getAttribute("aria-label") ?? "",
      )
    }
    return parts.join("\n")
  })
}

async function toWebp(converter, png) {
  const data = await converter.evaluate(async (b64) => {
    const image = new Image()
    image.src = `data:image/png;base64,${b64}`
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    canvas.getContext("2d").drawImage(image, 0, 0)
    return canvas.toDataURL("image/webp", 0.82)
  }, png.toString("base64"))
  if (!data.startsWith("data:image/webp;base64,"))
    throw new Error("This browser cannot encode WebP")
  return Buffer.from(data.slice("data:image/webp;base64,".length), "base64")
}

/**
 * The only way this script writes a picture: hide shown-once keys, check the page's text for
 * leaks (any finding stops the run), capture, convert, write. A static test keeps every capture
 * going through here (scripts/test/site-leaks.test.ts).
 */
async function capture(page, converter, name, secrets, written) {
  await hideKeys(page)
  await page.evaluate(() => document.fonts.ready)
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
    await page.waitForTimeout(150)
    assertNoLeaks(await visibleText(page), secrets, `${name} (${theme})`)
    const png = await page.screenshot({ animations: "disabled", caret: "hide" })
    const file = path.join(OUT, `${name}-${theme}.webp`)
    writeFileSync(file, await toWebp(converter, png))
    written.push(path.relative(root, file))
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  const temp = mkdtempSync(path.join(os.tmpdir(), "kervan-site-shots-"))
  // Studio's default port when it is free, so the pictures show the same address each time.
  const port = (await portFree(4310)) ? 4310 : await freePort()
  const masterKey = randomBytes(32).toString("base64")
  const studio = await startStudio(port, temp, masterKey)
  const browser = await chromium.launch({ args: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1`] })
  const written = []
  try {
    const secrets = machineSecrets([studio.token, masterKey, PASSWORD, temp])
    const context = await browser.newContext({
      viewport: WIDE,
      deviceScaleFactor: 1,
      userAgent: USER_AGENT,
      extraHTTPHeaders: { "x-forwarded-for": CLIENT_IP },
      locale: "en-US",
      timezoneId: "UTC",
    })
    const page = await context.newPage()
    const converter = await context.newPage()
    const base = `http://${HOST}:${port}`

    // The first admin's setup page, empty, before anything exists.
    await page.goto(`${base}/setup`)
    await page.getByRole("heading", { name: "Set up Kervan Studio" }).waitFor()
    await capture(page, converter, "setup", secrets, written)

    const ids = await seed(port, studio.token)
    secrets.push(...ids.keys)

    await page.goto(base)
    await page.getByLabel("Email").fill("ops@example.test")
    await page.getByLabel("Password").fill(PASSWORD)
    await page.getByRole("button", { name: "Sign in" }).click()
    await page.getByRole("heading", { name: "Servers", exact: true }).waitFor()
    await capture(page, converter, "servers", secrets, written)

    // The editor with the published version, then the playground calling a tool.
    await page.goto(`${base}/#/servers/${ids.weather}`)
    await page.getByText("specVersion").first().waitFor()
    await page.waitForTimeout(800)
    await capture(page, converter, "editor", secrets, written)
    await page.getByRole("button", { name: "Connect" }).click()
    await page
      .getByRole("button", { name: /search_city/ })
      .first()
      .click()
    await page.getByLabel("Arguments (JSON)").fill('{ "name": "Ankara" }')
    await page.getByRole("button", { name: "Call search_city" }).click()
    await page.getByRole("region", { name: "Result" }).waitFor()
    await page.getByRole("region", { name: "Result" }).scrollIntoViewIfNeeded()
    await capture(page, converter, "playground", secrets, written)

    // A draft with a mistake: the editor marks it and lists the problem.
    const mistake = "      url: https://status.example.com/api/v2/summary.json"
    await ids.admin.call("POST", `/api/servers/${ids.status}/versions`, {
      yaml: STATUS_SPEC.replace(mistake, `${mistake}\n      timeoutMS: 5000`),
    })
    await page.goto(`${base}/#/servers/${ids.status}`)
    await page.getByText("specVersion").first().waitFor()
    await page.getByRole("button", { name: "Save as new version" }).waitFor()
    await page.waitForTimeout(1500)
    await capture(page, converter, "validation", secrets, written)

    for (const [tab, name, server] of [
      ["Versions", "versions", ids.weather],
      ["Secrets", "secrets", ids.issues],
      ["API keys", "keys", ids.weather],
      ["Calls", "calls", ids.weather],
    ]) {
      await page.goto(`${base}/#/servers/${server}`)
      await page.getByRole("tab", { name: new RegExp(`^${tab}`) }).click()
      await page.waitForTimeout(700)
      await capture(page, converter, name, secrets, written)
    }

    // A new key: shown once, with the connect commands for each shell.
    await page.goto(`${base}/#/servers/${ids.weather}`)
    await page.getByRole("tab", { name: /^API keys/ }).click()
    await page.getByRole("button", { name: "Create key" }).first().click()
    await page.getByLabel("Key name").fill("Release laptop")
    await page.getByRole("dialog").getByRole("button", { name: "Create key" }).click()
    await page.getByRole("dialog").getByText("claude mcp add").first().waitFor()
    // The real key is in the page now: it is replaced before every check and capture.
    const shownKey = await page.evaluate(
      () => /kvn_[A-Za-z0-9_-]{40,}/.exec(document.body.innerText)?.[0],
    )
    if (shownKey) secrets.push(shownKey)
    await capture(page, converter, "connect-key", secrets, written)
    for (const [tab, name] of [
      ["bash / zsh", "connect-bash"],
      ["PowerShell", "connect-powershell"],
    ]) {
      await page.getByRole("dialog").getByRole("tab", { name: tab }).click()
      await page.waitForTimeout(300)
      await capture(page, converter, name, secrets, written)
    }
    await page.keyboard.press("Escape")

    for (const [hash, name, heading] of [
      ["#/users", "users", "Users"],
      ["#/audit", "audit", "Audit log"],
      ["#/profile", "profile", "Profile"],
      ["#/settings", "settings", "Settings"],
    ]) {
      await page.goto(`${base}/${hash}`)
      await page.getByRole("heading", { name: heading, exact: true }).waitFor()
      await page.waitForTimeout(500)
      await capture(page, converter, name, secrets, written)
    }

    // Phone width.
    await page.setViewportSize(NARROW)
    await page.goto(`${base}/#/`)
    await page.getByRole("heading", { name: "Servers", exact: true }).waitFor()
    await capture(page, converter, "mobile-servers", secrets, written)
    await page.goto(`${base}/#/servers/${ids.weather}`)
    await page.getByText("specVersion").first().waitFor()
    await page.waitForTimeout(800)
    await capture(page, converter, "mobile-editor", secrets, written)
  } finally {
    await browser.close()
    await studio.stop()
    rmSync(temp, { recursive: true, force: true, maxRetries: 5 })
  }
  console.log(`Wrote ${written.length} screenshots to ${path.relative(root, OUT)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
