// Dates and times are English whatever the browser's language; focus rings follow the input
// modality; dialogs give focus back to what opened them.
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// A Turkish browser: every formatter that is not given a locale formats in tr-TR. Installed before
// the app's modules load, so formatters they create at import time see it too.
vi.hoisted(() => {
  const turkish = (locales: unknown) => locales ?? "tr-TR"
  for (const name of ["DateTimeFormat", "RelativeTimeFormat", "NumberFormat"] as const) {
    const original = Intl[name] as unknown as new (...args: unknown[]) => object
    ;(Intl as unknown as Record<string, unknown>)[name] = new Proxy(original, {
      construct: (target, [locales, options]) => new target(turkish(locales), options),
      apply: (target, _this, [locales, options]) => new target(turkish(locales), options),
    })
  }
  for (const method of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"] as const) {
    const original = Date.prototype[method]
    Date.prototype[method] = function (this: Date, locales?: unknown, options?: unknown) {
      return original.call(this, turkish(locales) as string, options as Intl.DateTimeFormatOptions)
    }
  }
})

import { setCsrfToken } from "../src/api.js"
import { trackInputModality } from "../src/modality.js"
import { Users } from "../src/pages/Admin.js"
import { Ago, ago, DateOnly, fullTime, shortDate, shortTime } from "../src/time.js"
import { Button } from "../src/ui/Button.js"
import { Dialog } from "../src/ui/Dialog.js"
import { chooseMenuItem } from "./helpers.js"

const OCT_7 = new Date(2026, 9, 7, 14, 41, 17).getTime()

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setCsrfToken(undefined)
})

describe("dates and times", () => {
  it("would be Turkish in this browser, if the app let the browser choose", () => {
    expect(new Intl.DateTimeFormat(undefined, { month: "short" }).format(OCT_7)).toBe("Eki")
    expect(new Date(OCT_7).toLocaleDateString()).toBe("07.10.2026")
  })

  it("are English all the same, in every helper", () => {
    const now = OCT_7 + 3 * 60_000
    expect(shortDate(OCT_7)).toBe("Oct 7, 2026")
    expect(shortTime(OCT_7)).toBe("Oct 7, 02:41:17 PM")
    expect(fullTime(OCT_7)).toMatch(/^Oct 7, 2026, 2:41:17\sPM /)
    expect(ago(OCT_7, now)).toBe("3 minutes ago")
    expect(ago(OCT_7 - 86_400_000, OCT_7)).toBe("yesterday")
    expect(ago(OCT_7 - 3 * 7 * 86_400_000, OCT_7)).toBe("3 weeks ago")
    expect(ago(OCT_7, OCT_7 + 10_000)).toBe("just now")
    const view = render(
      <p>
        <Ago time={Date.now() - 5 * 60_000} /> | <DateOnly time={OCT_7} /> | <Ago time={null} />
      </p>,
    )
    expect(view.container.textContent).toBe("5 minutes ago | Oct 7, 2026 | never")
    expect(view.container.querySelector("time")?.getAttribute("title")).toMatch(/^[A-Z][a-z]{2} /)
  })

  it("are English on a real page (the users list)", async () => {
    setCsrfToken("c")
    vi.stubGlobal("fetch", async () =>
      Response.json({
        users: [
          {
            id: "u1",
            email: "deniz@example.test",
            role: "member",
            createdAt: OCT_7,
            lastLoginAt: Date.now() - 3 * 60_000,
            disabledAt: null,
          },
        ],
      }),
    )
    const view = render(<Users currentUserId="other" />)
    await screen.findByText("deniz@example.test")
    const text = view.container.textContent ?? ""
    expect(text).toContain("Oct 7, 2026")
    expect(text).toContain("3 minutes ago")
    expect(text).not.toMatch(/Eki|dakika|önce/)
  })

  it("are formatted only in time.tsx (no other toLocale*String or Intl formatter)", () => {
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src")
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const full = path.join(dir, name)
        return statSync(full).isDirectory() ? files(full) : [full]
      })
    const offending = files(src)
      .filter((file) => !file.endsWith(`${path.sep}time.tsx`))
      .filter((file) => /toLocale\w*String|Intl\.\w+Format/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(src, file))
    expect(offending).toEqual([])
  })
})

describe("input modality (focus rings only for the keyboard)", () => {
  let stop: () => void
  const modality = () => document.documentElement.getAttribute("data-modality")
  beforeEach(() => {
    document.documentElement.removeAttribute("data-modality")
    stop = trackInputModality()
  })
  afterEach(() => stop())

  it("is the pointer after a click and the keyboard after navigation keys", () => {
    render(
      <>
        <button type="button">A</button>
        <input aria-label="field" />
      </>,
    )
    const button = screen.getByRole("button", { name: "A" })
    fireEvent.pointerDown(button)
    expect(modality()).toBe("pointer")
    for (const key of ["Shift", "Control", "a", "F5"]) {
      fireEvent.keyDown(button, { key })
      expect(modality(), key).toBe("pointer")
    }
    fireEvent.keyDown(button, { key: "c", ctrlKey: true })
    fireEvent.keyDown(button, { key: "Tab", altKey: true })
    expect(modality()).toBe("pointer")
    // Space and arrows inside a text field edit text.
    const field = screen.getByLabelText("field")
    for (const key of [" ", "ArrowLeft", "Home"]) {
      fireEvent.keyDown(field, { key })
      expect(modality(), key).toBe("pointer")
    }
    for (const key of ["Tab", "Escape", "Enter", "ArrowDown"]) {
      fireEvent.pointerDown(button)
      fireEvent.keyDown(field, { key })
      expect(modality(), key).toBe("keyboard")
    }
    fireEvent.pointerDown(button)
    fireEvent.keyDown(button, { key: " " })
    expect(modality()).toBe("keyboard")
  })

  it("hides rings for the pointer only, never for text fields (the CSS rule)", () => {
    const css = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "ui", "theme.css"),
      "utf8",
    )
    const rule = /:root\[data-modality="pointer"\][\s\S]*?\{\s*outline: none;\s*\}/.exec(css)?.[0]
    expect(rule).toBeDefined()
    expect(rule).toContain(":focus-visible")
    expect(rule).toMatch(/textarea/)
    expect(css).not.toMatch(/\[data-modality="keyboard"\][^{]*\{\s*outline: none/)
  })
})

describe("dialogs", () => {
  function Opener() {
    const [open, setOpen] = useState(false)
    return (
      <>
        <Button onClick={() => setOpen(true)}>Open it</Button>
        <Dialog
          open={open}
          onOpenChange={setOpen}
          title="A dialog"
          footer={<Button onClick={() => setOpen(false)}>Cancel</Button>}
        />
      </>
    )
  }

  it("give focus back to the button that opened them", async () => {
    render(<Opener />)
    const button = screen.getByRole("button", { name: "Open it" })
    button.focus()
    fireEvent.click(button)
    await screen.findByRole("dialog")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(button))
  })

  it("opened from a menu, give focus back to the menu's button", async () => {
    setCsrfToken("c")
    vi.stubGlobal("fetch", async () =>
      Response.json({ users: [{ id: "u1", email: "deniz@example.test", role: "member" }] }),
    )
    render(<Users currentUserId="other" currentUserEmail="admin@example.test" />)
    const actions = await screen.findByRole("button", { name: "Actions for deniz@example.test" })
    actions.focus()
    await chooseMenuItem(actions, "Change role")
    await screen.findByRole("dialog")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    await waitFor(() => expect(document.activeElement).toBe(actions))
  })
})
