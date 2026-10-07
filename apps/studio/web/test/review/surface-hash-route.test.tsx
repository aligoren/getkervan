// Security review (release, hash routing): a link like "#/servers/%E0%A4%A" (a malformed escape)
// used to throw inside render and leave a blank page, also after a reload. Server ids are UUIDs:
// only those characters make a server link, and anything else shows Studio's list.
import { act, cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../../src/App.js"
import { setCsrfToken } from "../../src/api.js"

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    if (url === "/api/session") {
      return json({ user: { id: "u", email: "m@example.test", role: "member" }, csrfToken: "c" })
    }
    if (url === "/api/servers") return json({ servers: [] })
    return json({ error: "Not found." }, 404)
  })
  // React reports the render error; keep the test output readable.
  vi.spyOn(console, "error").mockImplementation(() => {})
  window.addEventListener("error", swallow)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setCsrfToken(undefined)
  window.removeEventListener("error", swallow)
  window.location.hash = ""
})

function swallow(event: ErrorEvent) {
  event.preventDefault()
}

describe("a server link with a malformed escape", () => {
  it("still shows Studio (navigation and a message), not a blank page", async () => {
    window.location.hash = "#/servers/%E0%A4%A"
    let thrown: unknown
    try {
      await act(async () => {
        render(<App />)
      })
      // Let the session request finish and the signed-in shell render.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeUndefined()
    // The app shell's navigation is there (the page itself may say the server was not found).
    expect(screen.queryAllByRole("link", { name: /servers/i }).length).toBeGreaterThan(0)
  })
})
