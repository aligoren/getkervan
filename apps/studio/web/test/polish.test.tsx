// UI polish and user management screens: next steps, status badges, version checks, the forced
// password change, the profile, and the playground clearing a stale result.
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { App } from "../src/App.js"
import { type Server, type ServerSummary, setCsrfToken, type VersionInfo } from "../src/api.js"
import { NextSteps, rememberCommandCopied } from "../src/pages/NextSteps.js"
import { Profile } from "../src/pages/Profile.js"
import { CheckBadge, VersionsPanel } from "../src/pages/ServerPanels.js"
import { ServerList } from "../src/pages/Servers.js"

type Handler = (method: string, url: string, body: unknown) => Response | Promise<Response>
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

describe("next steps", () => {
  const overview = (over: Record<string, unknown>) => ({
    summary: {
      latest: {
        id: "v1",
        number: 1,
        check: { valid: true, problems: 0, secrets: 0, checkedAt: 0 },
      },
      publishedNumber: null,
      lastCallAt: null,
    },
    secrets: 0,
    activeKeys: 0,
    keyUsed: false,
    ...over,
  })

  it("ticks off what is done and lists what is left", async () => {
    handler = () => json(overview({}))
    const page = render(<NextSteps serverId="s1" isAdmin refresh={0} />)
    await page.findByText(/Publish it/)
    const items = [...page.container.querySelectorAll("li")].map((li) => [
      li.textContent?.replace(/[✓○]\s*/, ""),
      li.className === "done",
    ])
    expect(items).toEqual([
      ["Save a version of the spec that is valid (done)", true],
      ["Publish it", false],
      ["Add the secrets the spec uses (Secrets tab), if it uses any (done)", true],
      ["Create an API key (API keys tab)", false],
      ["Copy the connect command and connect a client", false],
    ])
  })

  it("counts a copied command, and disappears once everything is done", async () => {
    handler = () =>
      json(overview({ summary: { ...overview({}).summary, publishedNumber: 1 }, activeKeys: 1 }))
    rememberCommandCopied("s2")
    const page = render(<NextSteps serverId="s2" isAdmin refresh={0} />)
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(page.container.textContent).toBe("")
  })

  it("counts an older valid version when the newest has problems", async () => {
    const broken = { valid: false, problems: 2, secrets: 0, checkedAt: 0 }
    handler = () =>
      json(
        overview({
          summary: {
            latest: { id: "v2", number: 2, check: broken },
            publishedNumber: null,
            lastCallAt: null,
          },
          anyValid: true,
        }),
      )
    const page = render(<NextSteps serverId="s9" isAdmin={false} refresh={0} />)
    await page.findByText(/Publish it/)
    expect(page.container.querySelector("li")?.className).toBe("done")
    cleanup()
    handler = () =>
      json(
        overview({
          summary: {
            latest: { id: "v2", number: 2, check: broken },
            publishedNumber: null,
            lastCallAt: null,
          },
          anyValid: false,
        }),
      )
    const none = render(<NextSteps serverId="s9" isAdmin={false} refresh={0} />)
    await none.findByText(/Publish it/)
    expect(none.container.querySelector("li")?.className).not.toBe("done")
  })

  it("shows members only the steps they can take", async () => {
    handler = () => json({ summary: overview({}).summary })
    const page = render(<NextSteps serverId="s3" isAdmin={false} refresh={0} />)
    await page.findByText(/Publish it/)
    expect(page.container.querySelectorAll("li")).toHaveLength(2)
  })
})

describe("status in the server list and the version history", () => {
  const server = (summary: ServerSummary | null): Server => ({
    id: "s1",
    slug: "w",
    name: "W",
    publishedVersionId: "v1",
    logPayloads: false,
    createdAt: 0,
    updatedAt: 0,
    summary,
  })
  const check = (valid: boolean, problems = 0) => ({ valid, problems, secrets: 0, checkedAt: 0 })

  it("shows published, valid, invalid and unchecked drafts, and the last call", () => {
    const page = render(
      <ServerList
        servers={[
          server({
            latest: { id: "v2", number: 2, check: check(false, 3) },
            publishedNumber: 1,
            lastCallAt: 0,
          }),
          {
            ...server({
              latest: { id: "v1", number: 1, check: null },
              publishedNumber: null,
              lastCallAt: null,
            }),
            id: "s2",
          },
          {
            ...server({
              latest: { id: "v3", number: 3, check: check(true) },
              publishedNumber: 3,
              lastCallAt: null,
            }),
            id: "s3",
          },
        ]}
      />,
    )
    const rows = [...page.container.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll(".badge")].map((badge) => `${badge.className}:${badge.textContent}`),
    )
    expect(rows).toEqual([
      ["badge ok:published v1", "badge bad:draft v2 has problems"],
      ["badge plain:not published", "badge plain:draft v1 not checked"],
      ["badge ok:published v3"],
    ])
    expect(page.container.textContent).toContain("—")
  })

  it("marks each version in the history", () => {
    const version = (number: number, c: unknown): VersionInfo =>
      ({
        id: `v${number}`,
        serverId: "s1",
        number,
        sha256: "",
        createdAt: 0,
        check: c,
      }) as VersionInfo
    const page = render(
      <VersionsPanel
        server={server(null)}
        versions={[version(3, check(false, 2)), version(2, null), version(1, check(true))]}
        onOpen={() => {}}
        onChanged={() => {}}
      />,
    )
    const badges = [...page.container.querySelectorAll("tbody .badge")].map((b) => b.textContent)
    expect(badges).toEqual(["2 problems", "not checked", "valid"])
    expect(render(<CheckBadge check={check(false, 1)} />).container.textContent).toBe("1 problem")
  })
})

describe("a forced password change", () => {
  it("shows only the change form until a new password is chosen, then the app", async () => {
    let mustChange = true
    handler = (method, url) => {
      if (url === "/api/session") {
        return json({
          user: {
            id: "u",
            email: "m@example.test",
            role: "member",
            mustChangePassword: mustChange,
          },
          csrfToken: "c",
        })
      }
      if (url === "/api/profile/password" && method === "PUT") {
        mustChange = false
        return json({ sessionsEnded: 0 })
      }
      if (url === "/api/servers") return json({ servers: [] })
      return json({ error: "nope" }, 403)
    }
    const page = render(<App />)
    await page.findByText("Choose a new password")
    expect(page.queryByText("Servers")).toBeNull()
    fireEvent.change(page.getByLabelText("Current password"), {
      target: { value: "temporary pw 123" },
    })
    fireEvent.change(page.getByLabelText("New password (at least 12 characters)"), {
      target: { value: "my own new password" },
    })
    fireEvent.change(page.getByLabelText("Repeat the new password"), {
      target: { value: "my own new password" },
    })
    fireEvent.click(page.getByRole("button", { name: "Change password" }))
    await page.findByRole("heading", { name: "Servers" })
    const change = requests.find((r) => r.url === "/api/profile/password")
    expect(change?.body).toEqual({
      currentPassword: "temporary pw 123",
      newPassword: "my own new password",
    })
  })
})

describe("the profile page", () => {
  const sessions = [
    {
      ref: "r1",
      current: true,
      createdAt: 0,
      lastSeenAt: 0,
      ip: "203.0.113.1",
      userAgent: "Firefox",
    },
    { ref: "r2", current: false, createdAt: 0, lastSeenAt: 0, ip: "198.51.100.2", userAgent: null },
  ]

  it("uses the right autocomplete hints and refuses mismatched new passwords locally", async () => {
    handler = (_method, url) =>
      url === "/api/profile"
        ? json({ user: { id: "u", email: "m@example.test", role: "member", createdAt: 0 } })
        : json({ sessions })
    const page = render(<Profile onChanged={() => {}} />)
    await page.findByText("m@example.test")
    const current = page.getByLabelText("Current password") as HTMLInputElement
    const next = page.getByLabelText("New password (at least 12 characters)") as HTMLInputElement
    expect([current.type, current.autocomplete]).toEqual(["password", "current-password"])
    expect([next.type, next.autocomplete]).toEqual(["password", "new-password"])
    fireEvent.change(current, { target: { value: "x" } })
    fireEvent.change(next, { target: { value: "one new password" } })
    fireEvent.change(page.getByLabelText("Repeat the new password"), {
      target: { value: "another new one" },
    })
    fireEvent.click(page.getByRole("button", { name: "Change password" }))
    await page.findByText("The new passwords do not match.")
    expect(requests.some((r) => r.method === "PUT")).toBe(false)
  })

  it("lists sessions, marks this one, and signs out another", async () => {
    handler = (method, url) =>
      url === "/api/profile"
        ? json({ user: { id: "u", email: "m@example.test", role: "member", createdAt: 0 } })
        : method === "DELETE"
          ? json({ ok: true })
          : json({ sessions })
    const page = render(<Profile onChanged={() => {}} />)
    await page.findByText("this session")
    expect(page.container.textContent).toContain("198.51.100.2")
    fireEvent.click(page.getByRole("button", { name: "Sign out" }))
    await waitFor(() =>
      expect(requests.find((r) => r.method === "DELETE")?.url).toBe("/api/profile/sessions/r2"),
    )
  })
})

describe("the playground", () => {
  it("clears the previous tool's result and error when another tool is chosen", async () => {
    const { Playground } = await import("../src/playground/Playground.js")
    const client = await import("../src/playground/client.js")
    const fake = {
      listTools: async () => ({
        tools: [
          { name: "first", inputSchema: { type: "object" } },
          { name: "second", inputSchema: { type: "object" } },
        ],
      }),
      callTool: async () => ({ content: [{ type: "text", text: "result of first" }] }),
      close: async () => {},
    }
    const spy = vi
      .spyOn(client, "connectPlayground")
      .mockResolvedValue(fake as unknown as Awaited<ReturnType<typeof client.connectPlayground>>)
    handler = () => json({ token: "kvp_x", expiresAt: 0, mcpPath: "/s/s1/mcp" })
    const page = render(<Playground serverId="s1" versionId="v1" />)
    fireEvent.click(page.getByRole("button", { name: "Connect" }))
    fireEvent.click(await page.findByRole("button", { name: "first" }))
    fireEvent.click(page.getByRole("button", { name: "Call first" }))
    await page.findByText("result of first")
    fireEvent.click(page.getByRole("button", { name: "second" }))
    expect(page.queryByText("result of first")).toBeNull()
    spy.mockRestore()
  })
})
