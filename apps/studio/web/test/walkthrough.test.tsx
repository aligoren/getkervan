// Fixes from the end-to-end walkthrough: returning to sign-in when the session ends, saving a
// secret, revoking a key, connecting a client, and starting playground arguments.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../src/App.js"
import { api, onSessionEnded, setCsrfToken } from "../src/api.js"
import { KeysPanel, SecretsPanel } from "../src/pages/ServerPanels.js"
import { argumentSkeleton } from "../src/playground/skeleton.js"
import { ToastProvider } from "../src/ui/Toast.js"

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
  onSessionEnded(undefined)
})

describe("when the session ends while a page is open", () => {
  it("returns to sign-in and says why", async () => {
    let signedIn = true
    handler = (method, url) => {
      if (url === "/api/session") {
        return signedIn
          ? json({ user: { id: "u", email: "a@example.test", role: "member" }, csrfToken: "c" })
          : json({ user: null, setupNeeded: false })
      }
      if (url === "/api/servers" && method === "GET") {
        return signedIn ? json({ servers: [] }) : json({ error: "Sign in first." }, 401)
      }
      return json({ error: "Sign in first." }, 401)
    }
    const page = render(<App />)
    await page.findByRole("heading", { name: "Servers" })
    expect(page.getByRole("navigation", { name: "Main" }).textContent).toContain("Servers")
    // Deactivated (or signed out elsewhere): the next request is refused.
    signedIn = false
    await api("POST", "/servers", { slug: "x", name: "X" }).catch(() => {})
    await page.findByText("Your session ended. Sign in again.")
    expect(page.getByRole("button", { name: "Sign in" })).toBeTruthy()
  })

  it("does not treat a wrong password on the sign-in page as an ended session", async () => {
    const ended = vi.fn()
    onSessionEnded(ended)
    handler = () => json({ error: "Wrong email or password." }, 401)
    await api("POST", "/login", { email: "a", password: "b" }).catch(() => {})
    await api("GET", "/me").catch(() => {})
    expect(ended).not.toHaveBeenCalled()
  })
})

describe("the secrets panel", () => {
  it("confirms a save and clears the form", async () => {
    handler = (method) => (method === "GET" ? json({ secrets: [] }) : json({ secret: {} }))
    render(
      <ToastProvider>
        <SecretsPanel serverId="s1" />
      </ToastProvider>,
    )
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }))
    fireEvent.change(screen.getByLabelText("Secret name"), { target: { value: "API_KEY" } })
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value: "value-123456" } })
    fireEvent.change(screen.getByLabelText("Allowed hosts"), {
      target: { value: "api.example.com" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save secret" }))
    await screen.findByText("Saved API_KEY.")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    // The next secret starts from an empty form.
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }))
    expect((screen.getByLabelText("Secret name") as HTMLInputElement).value).toBe("")
    expect((screen.getByLabelText("Secret value") as HTMLInputElement).value).toBe("")
    expect((screen.getByLabelText("Allowed hosts") as HTMLInputElement).value).toBe("")
  })
})

describe("the API keys panel", () => {
  const key = { id: "k1", name: "ci", prefix: "kvn_abcdefgh", createdAt: 0, lastUsedAt: null }

  it("asks before revoking", async () => {
    handler = (method) =>
      method === "GET" ? json({ keys: [{ ...key, revokedAt: null }] }) : json({ ok: true })
    render(<KeysPanel serverId="s1" />)
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }))
    expect(await screen.findByRole("dialog", { name: "Revoke ci?" })).toBeTruthy()
    expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(0)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }))
    fireEvent.click(await screen.findByRole("button", { name: "Revoke key" }))
    await waitFor(() => expect(requests.filter((r) => r.method === "DELETE")).toHaveLength(1))
    expect(requests.find((r) => r.method === "DELETE")?.url).toBe("/api/servers/s1/keys/k1")
  })

  it("shows the full endpoint and a ready connect command for a new key", async () => {
    handler = (method) =>
      method === "GET" ? json({ keys: [] }) : json({ key: "kvn_new-key-value", info: key }, 201)
    const page = render(<KeysPanel serverId="s1" serverSlug="weather" />)
    const endpoint = `${window.location.origin}/s/s1/mcp`
    expect(page.container.textContent).toContain(endpoint)
    fireEvent.click(screen.getByRole("button", { name: "Create key" }))
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "ci" } })
    // The page behind the dialog is hidden from assistive tech: this is the dialog's button.
    fireEvent.click(screen.getByRole("button", { name: "Create key" }))
    const field = (await screen.findByLabelText("New API key")) as HTMLInputElement
    expect(field.value).toBe("kvn_new-key-value")
    const figure = screen.getByRole("figure", { name: "Connect command for Claude Code" })
    expect(figure.querySelector("pre")?.textContent).toBe(
      `claude mcp add --transport http weather ${endpoint} --header "Authorization: Bearer kvn_new-key-value"`,
    )
    // Separate buttons for the key and the command.
    expect(screen.getByRole("button", { name: "Copy key" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Copy command" })).toBeTruthy()
  })
})

describe("playground arguments", () => {
  it("start from the input schema's required properties, typed", () => {
    const schema = {
      type: "object",
      properties: {
        name: { type: "string" },
        count: { type: "integer", default: 5 },
        unit: { enum: ["c", "f"] },
        exact: { type: "boolean" },
        optional: { type: "string" },
      },
      required: ["name", "count", "unit", "exact"],
    }
    expect(JSON.parse(argumentSkeleton(schema))).toEqual({
      name: "",
      count: 5,
      unit: "c",
      exact: false,
    })
  })

  it("use every property when none is required, and survive odd schemas", () => {
    expect(
      JSON.parse(argumentSkeleton({ properties: { lat: { type: "number" }, tags: {} } })),
    ).toEqual({ lat: 0, tags: null })
    expect(argumentSkeleton(undefined)).toBe("{}")
    expect(argumentSkeleton({ properties: [], required: [1, {}] })).toBe("{}")
  })
})
