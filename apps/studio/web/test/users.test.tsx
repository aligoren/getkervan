import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setCsrfToken } from "../src/api.js"
import { Users } from "../src/pages/Admin.js"

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

describe("the users page", () => {
  it("asks before deactivating, then reactivates", async () => {
    const page = render(<Users />)
    fireEvent.click(await page.findByRole("button", { name: "Deactivate" }))
    // The first click only asks; Cancel goes back.
    await page.findByText("Deactivate member@example.test? They are signed out at once.")
    fireEvent.click(page.getByRole("button", { name: "Cancel" }))
    expect(puts()).toHaveLength(0)
    fireEvent.click(await page.findByRole("button", { name: "Deactivate" }))
    await page.findByText("They created no API keys that are still active.")
    fireEvent.click(page.getByRole("button", { name: "Deactivate now" }))
    const reactivate = await page.findByRole("button", { name: "Reactivate" })
    expect(page.container.textContent).toContain("deactivated")
    expect(puts()[0]).toMatchObject({ url: "/api/users/u1", body: { disabled: true } })
    fireEvent.click(reactivate)
    await waitFor(() => expect(puts()).toHaveLength(2))
    expect(puts()[1]?.body).toEqual({ disabled: false })
  })

  it("lists the user's API keys and revokes them only when asked", async () => {
    keys = [
      { id: "k1", name: "ci", prefix: "kvn_abcdefgh", serverName: "Weather" },
      { id: "k2", name: "laptop", prefix: "kvn_12345678", serverName: "Search" },
    ]
    const page = render(<Users />)
    fireEvent.click(await page.findByRole("button", { name: "Deactivate" }))
    await page.findByText("ci (kvn_abcdefgh…) on Weather")
    expect(page.container.textContent).toContain("laptop (kvn_12345678…) on Search")
    const checkbox = page.getByLabelText("Also revoke these 2 API key(s)") as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    fireEvent.click(checkbox)
    fireEvent.click(page.getByRole("button", { name: "Deactivate now" }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ disabled: true, revokeKeys: true })
  })

  it("does not revoke keys when the box is left unchecked", async () => {
    keys = [{ id: "k1", name: "ci", prefix: "kvn_abcdefgh", serverName: "Weather" }]
    const page = render(<Users />)
    fireEvent.click(await page.findByRole("button", { name: "Deactivate" }))
    fireEvent.click(await page.findByRole("button", { name: "Deactivate now" }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]?.body).toEqual({ disabled: true })
  })
})
