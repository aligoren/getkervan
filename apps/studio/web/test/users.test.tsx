import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setCsrfToken } from "../src/api.js"
import { Users } from "../src/pages/Admin.js"
import { chooseMenuItem } from "./helpers.js"

const requests: { method: string; url: string; body: unknown }[] = []
let disabledAt: number | null = null
let keys: { id: string; name: string; prefix: string; serverName: string }[] = []

beforeEach(() => {
  requests.length = 0
  disabledAt = null
  keys = []
  setCsrfToken("csrf-test")
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    requests.push({ method, url, body })
    if (method === "PUT") disabledAt = (body as { disabled: boolean }).disabled ? 1 : null
    const users = [{ id: "u1", email: "member@example.test", role: "member", disabledAt }]
    const data =
      url === "/api/users/u1/keys" ? { keys } : method === "GET" ? { users } : { user: users[0] }
    return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } })
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setCsrfToken(undefined)
})

const puts = () => requests.filter((r) => r.method === "PUT")

const actions = () => screen.findByRole("button", { name: "Actions for member@example.test" })
const dialogButton = (name: string) => screen.getByRole("button", { name })

describe("the users page", () => {
  it("asks before deactivating, then reactivates", async () => {
    render(<Users />)
    await chooseMenuItem(await actions(), "Deactivate")
    // The menu only asks; Cancel goes back.
    await screen.findByRole("dialog", { name: "Deactivate member@example.test?" })
    fireEvent.click(dialogButton("Cancel"))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(puts()).toHaveLength(0)
    await chooseMenuItem(await actions(), "Deactivate")
    await screen.findByText("They created no API keys that are still active.")
    fireEvent.click(dialogButton("Deactivate"))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(document.body.textContent).toContain("deactivated"))
    expect(puts()[0]).toMatchObject({ url: "/api/users/u1", body: { disabled: true } })
    // Deactivated rows are faded.
    expect(document.querySelector("tr[data-disabled]")).not.toBeNull()
    await chooseMenuItem(await actions(), "Reactivate")
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(puts()[1]?.body).toEqual({ disabled: false })
  })

  it("lists the user's API keys and revokes them by default", async () => {
    keys = [
      { id: "k1", name: "ci", prefix: "kvn_abcdefgh", serverName: "Weather" },
      { id: "k2", name: "laptop", prefix: "kvn_12345678", serverName: "Search" },
    ]
    render(<Users />)
    await chooseMenuItem(await actions(), "Deactivate")
    const dialog = await screen.findByRole("dialog")
    await waitFor(() => expect(dialog.textContent).toContain("ci kvn_abcdefgh… on Weather"))
    expect(dialog.textContent).toContain("laptop kvn_12345678… on Search")
    const checkbox = screen.getByLabelText(/Also revoke these 2 API key\(s\)/) as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    fireEvent.click(dialogButton("Deactivate"))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ disabled: true, revokeKeys: true })
  })

  it("does not revoke keys when the box is unchecked", async () => {
    keys = [{ id: "k1", name: "ci", prefix: "kvn_abcdefgh", serverName: "Weather" }]
    render(<Users />)
    await chooseMenuItem(await actions(), "Deactivate")
    fireEvent.click(await screen.findByLabelText(/Also revoke these 1 API key\(s\)/))
    fireEvent.click(dialogButton("Deactivate"))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ disabled: true })
  })
})
