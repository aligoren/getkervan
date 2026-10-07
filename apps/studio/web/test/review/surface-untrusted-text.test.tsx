// Security review (release): untrusted text the UI shows to other people. React text keeps it from
// being HTML; invisible and text-direction characters are also shown as marked escapes, so a
// right-to-left override cannot make "Forecast <U+202E>txt.exe" read "Forecast exe.txt" and tag
// characters cannot carry text a person never sees (and a model does read).
//
// Every special character here is built from its code point.
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import { CallLogTable, DiffView, IssueList, ToolList } from "../../src/components/untrusted.js"

afterEach(cleanup)

const RLO = String.fromCodePoint(0x202e)
const HIDDEN = String.fromCodePoint(0xe0049, 0xe0047, 0xe004e, 0xe004f, 0xe0052, 0xe0045)
const ESC = String.fromCodePoint(0x1b)

// The classes apps/studio/src/display-text.ts refuses or escapes.
const UNSAFE = new RegExp(
  `[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}${String.fromCodePoint(0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x180e)}]`,
  "u",
)
const codePoints = (text: string) =>
  [...text]
    .filter((character) => UNSAFE.test(character) && character !== "\n")
    .map((character) => `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase()}`)

describe("untrusted text on screen", () => {
  it("a tool's title and description (spec author -> playground users)", () => {
    const { container } = render(
      <ToolList
        tools={[
          { name: "forecast", title: `Forecast ${RLO}txt.exe`, description: `Gets it.${HIDDEN}` },
        ]}
      />,
    )
    expect(codePoints(container.textContent ?? "")).toEqual([])
  })

  it("a spec issue that quotes an unknown field (spec author -> whoever opens the version)", () => {
    const { container } = render(
      <IssueList
        issues={[
          {
            path: [],
            message: `Unknown field(s): x${RLO}${ESC}[8m.`,
            severity: "error",
            line: 1,
            column: 1,
          },
        ]}
      />,
    )
    expect(codePoints(container.textContent ?? "")).toEqual([])
  })

  it("a version diff an admin reviews before publishing (spec author -> reviewer)", () => {
    // The added line reads as a harmless description; what the model gets is longer.
    const { container } = render(
      <DiffView
        lines={[
          { kind: "same", text: "  - name: forecast" },
          { kind: "added", text: `    description: "Gets the forecast.${HIDDEN}"` },
        ]}
      />,
    )
    expect(codePoints(container.textContent ?? "")).toEqual([])
  })

  it("a call's logged arguments (MCP client -> admins)", () => {
    const { container } = render(
      <CallLogTable
        calls={[
          {
            id: 1,
            at: Date.now(),
            tool: "forecast",
            status: "ok",
            durationMs: 3,
            versionId: null,
            args: `{"city":"Izmir${RLO}"}`,
            result: `ok${HIDDEN}`,
          },
        ]}
      />,
    )
    expect(codePoints(container.textContent ?? "")).toEqual([])
  })
})
