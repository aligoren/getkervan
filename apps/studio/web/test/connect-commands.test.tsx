// The connect command for a new key, three ways: with the key in it, or reading the key from the
// environment in bash/zsh or PowerShell (typed hidden, so it stays out of the shell's history).
// The key itself is still shown once, in this dialog only; each command has its own copy button.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setCsrfToken } from "../src/api.js"
import { connectCommands, KeysPanel } from "../src/pages/ServerPanels.js"

const KEY = "kvn_test-only-not-a-real-key"
const copied: string[] = []

beforeEach(() => {
  copied.length = 0
  setCsrfToken("csrf-test")
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text) },
  })
  vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    const body = method === "GET" ? { keys: [] } : { key: KEY }
    return new Response(JSON.stringify(body), {
      status: method === "GET" ? 200 : 201,
      headers: { "content-type": "application/json" },
    })
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setCsrfToken(undefined)
})

async function openNewKey() {
  render(<KeysPanel serverId="s1" serverSlug="weather" />)
  fireEvent.click(screen.getByRole("button", { name: "Create key" }))
  fireEvent.change(screen.getByLabelText("Key name"), { target: { value: "ci" } })
  fireEvent.click(screen.getByRole("button", { name: "Create key" }))
  await screen.findByLabelText("New API key")
}

function showTab(name: string) {
  fireEvent.mouseDown(screen.getByRole("tab", { name }), { button: 0 })
}

function shownCommand(): string {
  return screen.getByRole("tabpanel").querySelector("pre")?.textContent ?? ""
}

async function copyShown(): Promise<string> {
  await act(async () => {
    fireEvent.click(
      within(screen.getByRole("tabpanel")).getByRole("button", { name: "Copy command" }),
    )
  })
  return copied.at(-1) ?? ""
}

describe("the connect command for a new key", () => {
  const endpoint = `${window.location.origin}/s/s1/mcp`

  it("offers the key in the command, bash/zsh and PowerShell, each with its own copy button", async () => {
    await openNewKey()
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "Key in the command",
      "bash / zsh",
      "PowerShell",
    ])

    expect(shownCommand()).toBe(
      `claude mcp add --transport http weather ${endpoint} --header "Authorization: Bearer ${KEY}"`,
    )
    expect(await copyShown()).toBe(shownCommand())

    showTab("bash / zsh")
    const bash = shownCommand()
    expect(bash).toBe(
      [
        "printf 'API key: '; read -rs KERVAN_API_KEY; echo",
        `claude mcp add --transport http weather ${endpoint} --header "Authorization: Bearer $KERVAN_API_KEY"`,
        "unset KERVAN_API_KEY",
      ].join("\n"),
    )
    expect(await copyShown()).toBe(bash)

    showTab("PowerShell")
    const powershell = shownCommand()
    expect(powershell).toContain('Read-Host "API key" -AsSecureString')
    expect(powershell).toContain('--header "Authorization: Bearer $env:KERVAN_API_KEY"')
    expect(powershell).toContain("Remove-Item Env:KERVAN_API_KEY")
    expect(await copyShown()).toBe(powershell)

    // The environment versions never hold the key; the key is still in its own field once.
    expect(bash).not.toContain(KEY)
    expect(powershell).not.toContain(KEY)
    expect((screen.getByLabelText("New API key") as HTMLInputElement).value).toBe(KEY)
    expect(screen.getByRole("button", { name: "Copy key" })).toBeTruthy()
  })

  it("forgets the key when the dialog closes", async () => {
    await openNewKey()
    fireEvent.click(screen.getByRole("button", { name: "Done" }))
    expect(document.body.textContent).not.toContain(KEY)
  })

  it("builds the commands from the slug and endpoint only", () => {
    const commands = connectCommands("weather", endpoint)
    expect(commands.inline(KEY)).toContain(KEY)
    for (const text of [commands.bash, commands.powershell]) {
      expect(text).toContain(`claude mcp add --transport http weather ${endpoint}`)
      expect(text).not.toMatch(/kvn_/)
    }
  })
})
