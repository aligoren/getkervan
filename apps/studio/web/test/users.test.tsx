import { cleanup, fireEvent, render, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { setCsrfToken } from "../src/api.js"
import { Users } from "../src/pages/Admin.js"

const requests: { method: string; url: string; body: unknown }[] = []
let disabledAt: number | null = null

beforeEach(() => {
  requests.length = 0
  disabledAt = null
  setCsrfToken("csrf-test")
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    requests.push({ method, url, body })
    if (method === "PUT") disabledAt = (body as { disabled: boolean }).disabled ? 1 : null
    const users = [{ id: "u1", email: "member@example.test", role: "member", disabledAt }]
    return new Response(JSON.stringify(method === "GET" ? { users } : { user: users[0] }), {
      headers: { "content-type": "application/json" },
    })
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setCsrfToken(undefined)
})

describe("the users page", () => {
  it("deactivates and reactivates a user", async () => {
    const page = render(<Users />)
    const deactivate = await page.findByRole("button", { name: "Deactivate" })
    expect(page.container.textContent).toContain("active")
    fireEvent.click(deactivate)
    const reactivate = await page.findByRole("button", { name: "Reactivate" })
    expect(page.container.textContent).toContain("deactivated")
    expect(requests.find((r) => r.method === "PUT")).toMatchObject({
      url: "/api/users/u1",
      body: { disabled: true },
    })
    fireEvent.click(reactivate)
    await waitFor(() => expect(requests.filter((r) => r.method === "PUT")).toHaveLength(2))
    expect(requests.filter((r) => r.method === "PUT")[1]?.body).toEqual({ disabled: false })
  })
})
