// What the audit page shows for a failed sign-in whose email held invisible characters: the
// escaped text Studio stored, character for character, and nothing invisible.
import { cleanup, render } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { AuditTable } from "../src/components/untrusted.js"

afterEach(cleanup)

// Invisible characters, by code point (none is written literally in this file).
const INVISIBLE = [0x0000, 0x000d, 0x000a, 0x202e, 0x200b].map((code) => String.fromCodePoint(code))

it("shows a stored escaped email exactly as stored, with no invisible character", () => {
  // As the API returns it (see apps/studio/test/display-text.test.ts).
  const stored = "evil\\u000D\\u000Alogin.success admin@example.test\\u0000\\u202Etxt.moc@x\\u200B"
  const view = render(
    <AuditTable
      events={[
        {
          id: 1,
          at: 0,
          actorType: "user",
          actorId: null,
          action: "login.failure",
          targetType: null,
          targetId: null,
          ip: "198.51.100.9",
          details: { email: stored },
        },
      ]}
    />,
  )
  const cell = [...view.container.querySelectorAll("dd")].find((dd) =>
    dd.textContent?.startsWith("evil"),
  )
  expect(cell?.textContent).toBe(stored)
  expect(cell?.textContent).toContain("\\u202E")
  for (const character of INVISIBLE) {
    expect(view.container.textContent?.includes(character), JSON.stringify(character)).toBe(false)
  }
})
