// Real names in any script are shown exactly as stored: in the users list (display names), the
// server list and the API keys panel.
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type Server, setCsrfToken } from "../src/api.js"
import { Users } from "../src/pages/Admin.js"
import { KeysPanel } from "../src/pages/ServerPanels.js"
import { ServerList } from "../src/pages/Servers.js"

const NAMES = [
  "Gökçe Şahin",
  "Işık Öztürk",
  "İbrahim",
  "Ayşe",
  "Zoë",
  "李雷",
  "Müller",
  "Ali 🚀",
  "A. Yılmaz",
]

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setCsrfToken(undefined)
})

describe("legitimate Unicode names on screen", () => {
  it("as display names in the users list", async () => {
    setCsrfToken("c")
    vi.stubGlobal("fetch", async () =>
      Response.json({
        users: NAMES.map((displayName, index) => ({
          id: `u${index}`,
          email: `user${index}@example.test`,
          role: "member",
          displayName,
        })),
      }),
    )
    render(<Users currentUserId="other" />)
    for (const name of NAMES) expect(await screen.findByText(name)).toBeTruthy()
  })

  it("as server names", () => {
    const servers = NAMES.map(
      (name, index): Server => ({
        id: `s${index}`,
        slug: `s${index}`,
        name,
        publishedVersionId: null,
        logPayloads: false,
        createdAt: 0,
        updatedAt: 0,
        summary: null,
      }),
    )
    render(<ServerList servers={servers} />)
    for (const name of NAMES) expect(screen.getByRole("link", { name }).textContent).toBe(name)
  })

  it("as API key names", async () => {
    vi.stubGlobal("fetch", async () =>
      Response.json({
        keys: NAMES.map((name, index) => ({
          id: `k${index}`,
          name,
          prefix: `kvn_${index}`,
          createdAt: 0,
          lastUsedAt: null,
          revokedAt: null,
        })),
      }),
    )
    render(<KeysPanel serverId="s1" />)
    for (const name of NAMES) expect((await screen.findByText(name)).textContent).toBe(name)
  })
})
