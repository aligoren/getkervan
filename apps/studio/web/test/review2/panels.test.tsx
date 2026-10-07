// Independent review: untrusted text in the panels the existing XSS test does not render (users,
// API key names, the delete-secret warning, version labels), and the playground token never
// reaching the page or the raw traffic log.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setCsrfToken } from "../../src/api.js"
import { Users } from "../../src/pages/Admin.js"
import { KeysPanel, SecretsPanel, VersionsPanel } from "../../src/pages/ServerPanels.js"
import { Playground } from "../../src/playground/Playground.js"

const PAYLOADS = [
  '<img src=x onerror="window.__pwned = 1">',
  "<script>window.__pwned = 1</script>",
  '<svg onload="window.__pwned = 1"></svg>',
  '<a href="javascript:window.__pwned = 1">click</a>',
]

function expectInert(container: HTMLElement, payload: string) {
  // The design system's own icons are SVGs (lucide); anything else is foreign.
  const foreign = [...container.querySelectorAll("img, script, iframe, svg, object, embed")].filter(
    (element) => !(element.tagName.toLowerCase() === "svg" && element.classList.contains("lucide")),
  )
  expect(foreign).toHaveLength(0)
  for (const element of container.querySelectorAll("*")) {
    for (const attribute of element.getAttributeNames()) {
      expect(attribute.startsWith("on"), `${element.tagName} ${attribute}`).toBe(false)
    }
    const href = element.getAttribute("href") ?? ""
    expect(href.toLowerCase().includes("javascript:"), href).toBe(false)
  }
  expect(container.textContent).toContain(payload)
  expect((window as { __pwned?: number }).__pwned).toBeUndefined()
}

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>
let handler: Handler
const calls: { url: string; init: RequestInit | undefined }[] = []

beforeEach(() => {
  calls.length = 0
  setCsrfToken("csrf-test")
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return handler(url, init)
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setCsrfToken(undefined)
})

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })

describe.each(PAYLOADS)("untrusted text in admin panels is never HTML: %s", (payload) => {
  it("in user emails", async () => {
    handler = () => json({ users: [{ id: "u1", email: payload, role: "member" }] })
    const { container } = render(<Users />)
    await waitFor(() => expect(container.textContent).toContain(payload))
    expectInert(container, payload)
  })

  it("in API key names and prefixes", async () => {
    handler = () =>
      json({
        keys: [
          {
            id: "k1",
            name: payload,
            prefix: payload,
            createdAt: 0,
            lastUsedAt: null,
            revokedAt: null,
          },
        ],
      })
    const { container } = render(<KeysPanel serverId="s1" />)
    await waitFor(() => expect(container.textContent).toContain(payload))
    expectInert(container, payload)
  })

  it("in the warning before deleting a secret in use", async () => {
    handler = (_url, init) =>
      init?.method === "DELETE"
        ? json({ error: payload, usedBy: { version: 1, tools: [payload] } }, 409)
        : json({
            secrets: [{ name: "API_KEY", allowedHosts: [payload], updatedAt: 0, usedBy: null }],
          })
    const { container, getByText } = render(<SecretsPanel serverId="s1" />)
    await waitFor(() => expect(container.textContent).toContain("API_KEY"))
    fireEvent.click(getByText("Delete"))
    const dialog = await screen.findByRole("dialog")
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }))
    })
    await waitFor(() => expect(dialog.textContent).toContain(payload))
    // The dialog is rendered outside the panel (a portal): check the whole page.
    expectInert(document.body, payload)
  })
})

describe("the secrets panel", () => {
  it("never shows a value it was given, and forgets it after saving", async () => {
    handler = (_url, init) =>
      init?.method === "PUT"
        ? json({ secret: { name: "API_KEY", allowedHosts: ["a.test:443"], updatedAt: 0 } })
        : json({ secrets: [] })
    render(<SecretsPanel serverId="s1" />)
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }))
    const value = "sk-typed-into-the-form-123"
    fireEvent.change(screen.getByLabelText("Secret name"), { target: { value: "API_KEY" } })
    fireEvent.change(screen.getByLabelText("Secret value"), { target: { value } })
    fireEvent.change(screen.getByLabelText("Allowed hosts"), { target: { value: "a.test" } })
    expect((screen.getByLabelText("Secret value") as HTMLInputElement).type).toBe("password")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Save secret" }))
    })
    // The dialog closes and the value is gone from the page; a new dialog starts empty.
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(document.body.innerHTML).not.toContain(value)
    fireEvent.click(screen.getByRole("button", { name: "Add secret" }))
    expect((screen.getByLabelText("Secret value") as HTMLInputElement).value).toBe("")
    // It went out once, with the CSRF token, to the server's own secret route.
    const put = calls.find((call) => call.init?.method === "PUT")
    expect(put?.url).toBe("/api/servers/s1/secrets/API_KEY")
    expect(new Headers(put?.init?.headers).get("x-csrf-token")).toBe("csrf-test")
  })
})

describe("the versions panel", () => {
  it("builds request paths from encoded ids only", async () => {
    handler = () => json({ lines: [] })
    const hostile = "../../users"
    const { container } = render(
      <VersionsPanel
        server={{
          id: hostile,
          slug: "s",
          name: "n",
          publishedVersionId: null,
          logPayloads: false,
          createdAt: 0,
          updatedAt: 0,
        }}
        versions={[{ id: "v1", serverId: hostile, number: 1, sha256: "x", createdAt: 0 }]}
        onOpen={() => {}}
        onChanged={() => {}}
      />,
    )
    const link = container.querySelector("a")
    expect(link?.getAttribute("href")).not.toContain("/../")
  })
})

describe("the playground", () => {
  it("never writes its token into the page or the raw traffic log", async () => {
    const token = `kvp_${"A".repeat(40)}.${"B".repeat(43)}`
    handler = (url) =>
      url.includes("/playground")
        ? json({ token, expiresAt: Date.now() + 60_000, mcpPath: "/s/s1/mcp" })
        : // The gateway refuses: the client logs the request and the response.
          json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null }, 401)
    const { container, getByText } = render(<Playground serverId="s1" versionId="v1" />)
    await act(async () => {
      fireEvent.click(getByText("Connect"))
    })
    await waitFor(() => expect(container.textContent).toMatch(/request/))
    // The gateway did get the token, as a bearer header...
    const mcp = calls.find((call) => call.url.includes("/s/s1/mcp"))
    const headers = new Headers(mcp?.init?.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${token}`)
    // ...and nothing on the page shows it, including the raw log.
    expect(container.innerHTML).not.toContain(token)
    expect(container.innerHTML).not.toContain(token.slice(4, 30))
  })
})
