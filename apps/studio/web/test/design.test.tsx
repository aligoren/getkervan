// The design-system round: slugs derived from names, the theme kept on the account, the app
// shell's navigation, and scroll hints on content wider than the screen.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../src/App.js"
import { setCsrfToken } from "../src/api.js"
import { AuditTable } from "../src/components/untrusted.js"
import { KeysPanel } from "../src/pages/ServerPanels.js"
import { CreateServerDialog } from "../src/pages/Servers.js"
import { SLUG, slugify } from "../src/slug.js"
import { Scroller } from "../src/ui/Scroller.js"

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
  document.documentElement.removeAttribute("data-theme")
  window.location.hash = ""
})

describe("slugs from names", () => {
  it.each([
    ["Weather", "weather"],
    ["Hava Durumu (İstanbul)", "hava-durumu-istanbul"],
    ["  --Çok  Güzel!! ", "cok-guzel"],
    ["Ilık Iğdır", "ilik-igdir"],
    ["Crème brûlée API v2", "creme-brulee-api-v2"],
    ["!!!", ""],
    ["", ""],
  ])("%j → %j", (name, slug) => {
    expect(slugify(name)).toBe(slug)
  })

  it("always fits the API's rule, even for long or dash-heavy names", () => {
    for (const name of ["x".repeat(100), "a-".repeat(40), `${"b".repeat(63)} c`, "-a-", "Ü"]) {
      const slug = slugify(name)
      expect(slug.length).toBeLessThanOrEqual(64)
      expect(slug === "" || SLUG.test(slug), `${name} → ${slug}`).toBe(true)
    }
  })
})

describe("the create server dialog", () => {
  const renderDialog = () => {
    const onCreated = vi.fn()
    const view = render(<CreateServerDialog open onOpenChange={() => {}} onCreated={onCreated} />)
    return { ...view, onCreated }
  }
  const name = () => screen.getByLabelText("Name") as HTMLInputElement
  const slug = () => screen.getByLabelText("Slug") as HTMLInputElement

  it("fills the slug from the name until the slug is edited", () => {
    renderDialog()
    fireEvent.change(name(), { target: { value: "Hava Durumu" } })
    expect(slug().value).toBe("hava-durumu")
    fireEvent.change(name(), { target: { value: "Hava Durumu İzmir" } })
    expect(slug().value).toBe("hava-durumu-izmir")
    // Once the user types a slug, the name no longer changes it.
    fireEvent.change(slug(), { target: { value: "weather" } })
    fireEvent.change(name(), { target: { value: "Weather in Izmir" } })
    expect(slug().value).toBe("weather")
  })

  it("explains an invalid slug and does not submit it", () => {
    renderDialog()
    fireEvent.change(name(), { target: { value: "Weather" } })
    fireEvent.change(slug(), { target: { value: "Bad Slug" } })
    expect(slug().getAttribute("aria-invalid")).toBe("true")
    expect(screen.getByText(/Use a-z, 0-9 and -/)).toBeTruthy()
    const submit = screen.getByRole("button", { name: "Create server" }) as HTMLButtonElement
    expect(submit.disabled).toBe(true)
  })

  it("creates the server with the derived slug", async () => {
    handler = () => json({ server: { id: "s1", slug: "hava-durumu", name: "Hava Durumu" } }, 201)
    const { onCreated } = renderDialog()
    fireEvent.change(name(), { target: { value: "Hava Durumu" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Create server" }))
    })
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: "/api/servers",
      body: { slug: "hava-durumu", name: "Hava Durumu" },
    })
    expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "s1" }))
  })
})

describe("the theme preference", () => {
  const user = (theme?: string) => ({
    id: "u",
    email: "m@example.test",
    role: "member",
    ...(theme ? { theme } : {}),
  })
  const themeOf = () => document.documentElement.getAttribute("data-theme")
  const sidebar = () => within(screen.getByRole("group", { name: "Theme" }))

  it("follows the account: applied at sign-in, saved on change, system again after sign-out", async () => {
    let saved = "dark"
    handler = (method, url, body) => {
      if (url === "/api/session") return json({ user: user(saved), csrfToken: "c" })
      if (url === "/api/profile/theme" && method === "PUT") {
        saved = (body as { theme: string }).theme
        return json({ theme: saved })
      }
      if (url === "/api/logout") return json({ ok: true })
      return json({ servers: [] })
    }
    render(<App />)
    await screen.findByRole("heading", { name: "Servers" })
    expect(themeOf()).toBe("dark")
    expect(sidebar().getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe(
      "true",
    )

    fireEvent.click(sidebar().getByRole("button", { name: "Light" }))
    expect(themeOf()).toBe("light")
    await waitFor(() =>
      expect(requests.find((r) => r.url === "/api/profile/theme")).toMatchObject({
        method: "PUT",
        body: { theme: "light" },
      }),
    )
    fireEvent.click(sidebar().getByRole("button", { name: "System" }))
    expect(themeOf()).toBeNull()
    await waitFor(() => expect(saved).toBe("system"))

    // Another device: the saved choice comes with the session.
    saved = "dark"
    cleanup()
    render(<App />)
    await screen.findByRole("heading", { name: "Servers" })
    expect(themeOf()).toBe("dark")
    // Signed out, the page follows the system again.
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
    await screen.findByRole("button", { name: "Sign in" })
    expect(themeOf()).toBeNull()
  })

  it("goes back to the previous choice when the server refuses it", async () => {
    handler = (method, url) => {
      if (url === "/api/session") return json({ user: user("dark"), csrfToken: "c" })
      if (url === "/api/profile/theme" && method === "PUT") {
        return json({ error: "Unknown theme." }, 400)
      }
      return json({ servers: [] })
    }
    render(<App />)
    await screen.findByRole("heading", { name: "Servers" })
    fireEvent.click(sidebar().getByRole("button", { name: "Light" }))
    await screen.findByText("Could not save the theme. Try again.")
    expect(themeOf()).toBe("dark")
  })

  it("uses the system theme on the sign-in page", async () => {
    document.documentElement.setAttribute("data-theme", "dark")
    handler = () => json({ user: null, setupNeeded: false })
    render(<App />)
    await screen.findByRole("button", { name: "Sign in" })
    expect(themeOf()).toBeNull()
  })

  it("can be chosen on the settings page too", async () => {
    window.location.hash = "#/settings"
    handler = (_method, url) => {
      if (url === "/api/session") return json({ user: user("system"), csrfToken: "c" })
      return json({ theme: "dark" })
    }
    render(<App />)
    await screen.findByRole("heading", { name: "Settings" })
    const groups = screen.getAllByRole("group", { name: "Theme" })
    expect(groups).toHaveLength(2)
    fireEvent.click(within(groups[1] as HTMLElement).getByRole("button", { name: "Dark" }))
    expect(themeOf()).toBe("dark")
    // Both switches show the same choice.
    for (const group of groups) {
      expect(within(group).getByRole("button", { name: "Dark" }).getAttribute("aria-pressed")).toBe(
        "true",
      )
    }
  })
})

describe("the app shell", () => {
  it("marks the current page and shows admin pages to admins only", async () => {
    window.location.hash = "#/profile"
    handler = (_method, url) => {
      if (url === "/api/session") {
        return json({ user: { id: "u", email: "a@example.test", role: "admin" }, csrfToken: "c" })
      }
      if (url === "/api/profile")
        return json({ user: { id: "u", email: "a@example.test", role: "admin", createdAt: 0 } })
      return json({ sessions: [] })
    }
    render(<App />)
    await screen.findByRole("heading", { name: "Profile" })
    const nav = within(screen.getByRole("navigation", { name: "Main" }))
    expect(nav.getByRole("link", { name: "Profile" }).getAttribute("aria-current")).toBe("page")
    expect(nav.getByRole("link", { name: "Servers" }).getAttribute("aria-current")).toBeNull()
    expect(nav.getByRole("link", { name: "Users" })).toBeTruthy()
    expect(nav.getByRole("link", { name: "Audit log" })).toBeTruthy()
  })

  it("opens the navigation in a drawer on narrow screens", async () => {
    handler = (_method, url) =>
      url === "/api/session"
        ? json({ user: { id: "u", email: "m@example.test", role: "member" }, csrfToken: "c" })
        : json({ servers: [] })
    render(<App />)
    await screen.findByRole("heading", { name: "Servers" })
    fireEvent.click(screen.getByRole("button", { name: "Open the menu" }))
    const drawer = await screen.findByRole("dialog")
    expect(within(drawer).getByRole("link", { name: "Settings" })).toBeTruthy()
    expect(within(drawer).queryByRole("link", { name: "Users" })).toBeNull()
  })
})

describe("scroll hints", () => {
  it("fade the edge that has more content, and only that one", () => {
    const view = render(
      <Scroller>
        <div style={{ width: 1000 }}>wide</div>
      </Scroller>,
    )
    const box = view.container.querySelector(".overflow-x-auto") as HTMLDivElement
    const left = view.container.querySelector('[data-edge="left"]') as HTMLElement
    const right = view.container.querySelector('[data-edge="right"]') as HTMLElement
    Object.defineProperty(box, "clientWidth", { value: 300, configurable: true })
    Object.defineProperty(box, "scrollWidth", { value: 1000, configurable: true })
    fireEvent.scroll(box)
    expect(left.className).toContain("opacity-0")
    expect(right.className).toContain("opacity-100")
    box.scrollLeft = 700
    fireEvent.scroll(box)
    expect(left.className).toContain("opacity-100")
    expect(right.className).toContain("opacity-0")
    // Fits: no hint at all.
    Object.defineProperty(box, "scrollWidth", { value: 300, configurable: true })
    box.scrollLeft = 0
    fireEvent.scroll(box)
    expect(left.className).toContain("opacity-0")
    expect(right.className).toContain("opacity-0")
  })
})

describe("the audit log", () => {
  it("names users and servers it knows, and shortens ids it does not", () => {
    const userId = "11111111-2222-4333-8444-555555555555"
    const serverId = "66666666-7777-4888-9999-aaaaaaaaaaaa"
    const view = render(
      <AuditTable
        names={
          new Map([
            [userId, "ayse@example.com"],
            [serverId, "Weather"],
          ])
        }
        events={[
          {
            id: 1,
            at: 0,
            actorType: "user",
            actorId: userId,
            action: "server.publish",
            targetType: "server",
            targetId: serverId,
            ip: null,
            details: { serverId, versionId: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff", version: 2 },
          },
        ]}
      />,
    )
    const row = view.container.querySelector("tbody tr") as HTMLElement
    expect(row.textContent).toContain("ayse@example.com")
    expect(row.textContent).toContain("server Weather")
    expect(row.textContent).toContain("bbbbbbbb")
    expect(row.textContent).not.toContain("bbbbbbbb-cccc")
    expect(row.textContent).not.toContain(userId)
  })
})

describe("a new API key", () => {
  it("leaves the page when its dialog closes", async () => {
    handler = (method) =>
      method === "GET"
        ? json({ keys: [] })
        : json({ key: "kvn_shown-once-value", info: { id: "k1" } }, 201)
    render(<KeysPanel serverId="s1" />)
    fireEvent.click(screen.getByRole("button", { name: "Create key" }))
    fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "ci" } })
    fireEvent.click(screen.getByRole("button", { name: "Create key" }))
    await screen.findByLabelText("New API key")
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    fireEvent.click(screen.getByRole("button", { name: "Create key" }))
    expect(await screen.findByLabelText("Key name")).toBeTruthy()
    expect(document.body.innerHTML).not.toContain("kvn_shown-once-value")
  })
})
