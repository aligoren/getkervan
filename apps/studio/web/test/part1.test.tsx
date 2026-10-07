// Leftovers from user management: device names, hidden username fields, the role change dialog,
// one-time values shown in full, and the Servers link for every user.
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../src/App.js"
import { setCsrfToken } from "../src/api.js"
import { deviceName } from "../src/device.js"
import { Users } from "../src/pages/Admin.js"
import { Profile } from "../src/pages/Profile.js"

type Handler = (method: string, url: string, body: unknown) => Response
let handler: Handler
const requests: { method: string; url: string; body: unknown }[] = []
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })

beforeEach(() => {
  requests.length = 0
  setCsrfToken("csrf-test")
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    requests.push({ method, url, body })
    return handler(method, url, body)
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setCsrfToken(undefined)
})

describe("device names", () => {
  it.each([
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
      "Chrome 154 · Windows",
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 Edg/150.0.0.0",
      "Edge 150 · Windows",
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
      "Safari 18 · macOS",
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
      "Firefox 140 · Linux",
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      "Safari 18 · iOS",
    ],
    [
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36",
      "Chrome 150 · Android",
    ],
    ["curl/8.9.1", "curl"],
    [null, "Unknown device"],
    ["something else entirely", "Unknown device"],
  ])("%s → %s", (ua, expected) => {
    expect(deviceName(ua)).toBe(expected)
  })
})

describe("password forms", () => {
  const hiddenUsername = (container: HTMLElement) =>
    container.querySelector<HTMLInputElement>('input[autocomplete="username"]')

  it("carry a hidden, read-only username for password managers on the profile", async () => {
    handler = (_m, url) =>
      url === "/api/profile"
        ? json({ user: { id: "u", email: "me@example.test", role: "member", createdAt: 0 } })
        : json({ sessions: [] })
    const page = render(<Profile onChanged={() => {}} />)
    await page.findByText("me@example.test")
    const username = hiddenUsername(page.container)
    expect(username?.value).toBe("me@example.test")
    expect(username?.readOnly).toBe(true)
    expect(username?.tabIndex).toBe(-1)
    expect(username?.closest("label")?.className).toBe("visually-hidden")
    expect(username?.closest("label")?.textContent).toContain("Username")
    const autocompletes = [
      ...page.container.querySelectorAll<HTMLInputElement>('input[type="password"]'),
    ].map((input) => input.autocomplete)
    expect(autocompletes).toEqual(["current-password", "new-password", "new-password"])
  })

  it("on the forced change and the sign-in page too", async () => {
    handler = (_m, url) =>
      url === "/api/session"
        ? json({
            user: { id: "u", email: "me@example.test", role: "member", mustChangePassword: true },
            csrfToken: "c",
          })
        : json({})
    const forced = render(<App />)
    await forced.findByText("Choose a new password")
    expect(hiddenUsername(forced.container)?.value).toBe("me@example.test")
    cleanup()
    handler = () => json({ user: null, setupNeeded: false })
    const login = render(<App />)
    await login.findByRole("button", { name: "Sign in" })
    const email = hiddenUsername(login.container)
    expect(email?.type).toBe("email")
    expect(
      login.container.querySelector<HTMLInputElement>('input[type="password"]')?.autocomplete,
    ).toBe("current-password")
  })
})

describe("the users page", () => {
  const users = [
    { id: "a", email: "admin@example.test", role: "admin", createdAt: 0, disabledAt: null },
    { id: "m", email: "member@example.test", role: "member", createdAt: 0, disabledAt: null },
  ]

  it("asks for confirmation and the admin's password before changing a role", async () => {
    handler = (method) => (method === "GET" ? json({ users }) : json({ user: users[1] }))
    const page = render(<Users currentUserId="a" currentUserEmail="admin@example.test" />)
    fireEvent.change(await page.findByLabelText("Role of member@example.test"), {
      target: { value: "admin" },
    })
    await page.findByText(/Make member@example.test an admin\?/)
    expect(requests.some((r) => r.method === "PUT")).toBe(false)
    fireEvent.click(page.getByRole("button", { name: "Cancel" }))
    expect(requests.some((r) => r.method === "PUT")).toBe(false)
    fireEvent.change(page.getByLabelText("Role of member@example.test"), {
      target: { value: "admin" },
    })
    const password = (await page.findByLabelText("Your password, to confirm")) as HTMLInputElement
    expect(password.autocomplete).toBe("current-password")
    fireEvent.change(password, { target: { value: "my admin password" } })
    fireEvent.click(page.getByRole("button", { name: "Make admin" }))
    await waitFor(() => expect(requests.some((r) => r.method === "PUT")).toBe(true))
    expect(requests.find((r) => r.method === "PUT")).toMatchObject({
      url: "/api/users/m/role",
      body: { role: "admin", adminPassword: "my admin password" },
    })
  })

  it("shows a generated temporary password in full, once", async () => {
    const temporary = "Generated-Temp-Password-Value-42"
    handler = (method, url) =>
      method === "GET"
        ? json({ users })
        : url.endsWith("/password-reset")
          ? json({ temporaryPassword: temporary, sessionsEnded: 0 })
          : json({})
    const page = render(<Users currentUserId="a" currentUserEmail="admin@example.test" />)
    const row = await page.findByText("member@example.test")
    fireEvent.click(row.closest("tr")?.querySelector("button:nth-of-type(2)") as HTMLButtonElement)
    fireEvent.change(await page.findByLabelText("Your password, to confirm"), {
      target: { value: "my admin password" },
    })
    const submit = page.container.querySelector<HTMLButtonElement>('form button[type="submit"]')
    if (submit) fireEvent.click(submit)
    const shown = (await page.findByLabelText("Temporary password", {
      exact: true,
    })) as HTMLInputElement
    expect(shown.value).toBe(temporary)
  })
})

describe("one-time values", () => {
  it("are never masked by product code (masking exists only in screenshot scripts)", () => {
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src")
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name)
        return statSync(full).isDirectory() ? files(full) : [full]
      })
    const offending = files(src).filter((file) => /mask/i.test(readFileSync(file, "utf8")))
    expect(offending).toEqual([])
  })
})

describe("navigation", () => {
  it("shows Servers to members too (they work on servers), but not Users or the audit log", async () => {
    handler = (_m, url) =>
      url === "/api/session"
        ? json({ user: { id: "u", email: "m@example.test", role: "member" }, csrfToken: "c" })
        : json({ servers: [] })
    const page = render(<App />)
    await page.findByRole("link", { name: "Servers" })
    expect(page.queryByRole("link", { name: "Users" })).toBeNull()
    expect(page.queryByRole("link", { name: "Audit log" })).toBeNull()
  })
})
