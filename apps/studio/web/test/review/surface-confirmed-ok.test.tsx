// Security review (release, UI surfaces): checks that held up, kept as regression tests.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setCsrfToken } from "../../src/api.js"
import { AuditTable, ToolList } from "../../src/components/untrusted.js"
import { KeysPanel } from "../../src/pages/ServerPanels.js"
import { SLUG } from "../../src/slug.js"

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
const KEY = `kvn_${"A1b2_-".repeat(7)}x`

beforeEach(() => {
  setCsrfToken("csrf-test")
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) =>
    (init?.method ?? "GET") === "GET"
      ? json({ keys: [] })
      : json({ key: KEY, info: { id: "k1" } }, 201),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setCsrfToken(undefined)
})

describe("the generated `claude mcp add` command", () => {
  it("holds only shell-safe characters: slug, Studio's own origin, a UUID path and a base64url key", async () => {
    // The slug rule has no shell metacharacter, space or leading dash.
    for (const bad of ["a;b", "a b", "-a", "a$b", "a`b", "a&b", "a|b", "a'b", 'a"b', "A"]) {
      expect(SLUG.test(bad), bad).toBe(false)
    }
    render(<KeysPanel serverId="0b4ad6a4-0000-4000-8000-000000000000" serverSlug="weather-1" />)
    fireEvent.click(await screen.findByRole("button", { name: "Create key" }))
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "ci" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create key" }))
    })
    await screen.findByLabelText("New API key")
    const command = [...document.querySelectorAll("*")]
      .map((element) => (element as HTMLInputElement).value ?? "")
      .concat([...document.querySelectorAll("code, pre, span, p")].map((e) => e.textContent ?? ""))
      .find((text) => text.startsWith("claude mcp add"))
    expect(command).toMatch(
      /^claude mcp add --transport http weather-1 https?:\/\/[a-z0-9.:-]+\/s\/[0-9a-f-]{36}\/mcp --header "Authorization: Bearer kvn_[A-Za-z0-9_-]{43}"$/,
    )
  })
})

describe("markup in untrusted text", () => {
  it("stays text in tool lists and audit details", () => {
    const payload = '<img src=x onerror="alert(1)"><a href="javascript:alert(1)">x</a>'
    const { container } = render(
      <>
        <ToolList tools={[{ name: "t", title: payload, description: payload }]} />
        <AuditTable
          events={[
            {
              id: 1,
              at: 0,
              actorType: "anonymous",
              actorId: null,
              action: "login.failure",
              targetType: null,
              targetId: null,
              ip: "127.0.0.1",
              details: { email: payload },
            },
          ]}
        />
      </>,
    )
    expect(container.querySelector("img, a[href^='javascript']")).toBeNull()
    expect(container.textContent).toContain(payload)
  })
})
