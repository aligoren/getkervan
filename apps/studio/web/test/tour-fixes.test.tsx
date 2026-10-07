// Fixes from the from-scratch tour, in the web UI.
import { cleanup, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import type { Server, VersionCheck, VersionInfo } from "../src/api.js"
import { CallLogTable, callerLabel } from "../src/components/untrusted.js"
import { publishBlockedReason, VersionsPanel } from "../src/pages/ServerPanels.js"
import { StatusBadges } from "../src/pages/Servers.js"

afterEach(cleanup)

const server = (publishedVersionId: string | null): Server => ({
  id: "s1",
  slug: "w",
  name: "W",
  publishedVersionId,
  logPayloads: false,
  createdAt: 0,
  updatedAt: 0,
})
const version = (number: number, check: VersionCheck | null): VersionInfo => ({
  id: `v${number}`,
  serverId: "s1",
  number,
  sha256: "",
  createdAt: 0,
  check,
})

describe("a version with problems", () => {
  it("cannot be published or rolled back to, and says why", () => {
    render(
      <VersionsPanel
        server={server("v2")}
        versions={[
          version(3, { valid: false, problems: 2, secrets: 0, checkedAt: 0 }),
          version(2, { valid: true, problems: 0, secrets: 0, checkedAt: 0 }),
          version(1, { valid: false, problems: 1, secrets: 0, checkedAt: 0 }),
        ]}
        onOpen={() => {}}
        onChanged={() => {}}
      />,
    )
    const rows = screen.getAllByRole("row").slice(1)
    const publish3 = within(rows[0] as HTMLElement).getByRole("button", { name: "Publish" })
    expect((publish3 as HTMLButtonElement).disabled).toBe(true)
    expect(rows[0]?.textContent).toContain(
      "v3 has 2 problems. Open it, fix them and save a new version to publish.",
    )
    const rollback1 = within(rows[2] as HTMLElement).getByRole("button", {
      name: "Roll back to v1",
    })
    expect((rollback1 as HTMLButtonElement).disabled).toBe(true)
    expect(rows[2]?.textContent).toContain("v1 has 1 problem.")
  })

  it("an unchecked or valid version can be published", () => {
    expect(publishBlockedReason({ number: 4, check: null })).toBeUndefined()
    expect(
      publishBlockedReason({
        number: 4,
        check: { valid: true, problems: 0 },
      }),
    ).toBeUndefined()
    render(
      <VersionsPanel
        server={server(null)}
        versions={[version(1, null)]}
        onOpen={() => {}}
        onChanged={() => {}}
      />,
    )
    expect((screen.getByRole("button", { name: "Publish" }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })
})

describe("a disabled server", () => {
  it("is marked disabled wherever its status shows", () => {
    const view = render(<StatusBadges server={{ ...server("v1"), disabledAt: 1 }} />)
    expect(view.container.querySelector('[data-tone="danger"]')?.textContent).toBe("disabled")
    cleanup()
    const enabled = render(<StatusBadges server={{ ...server("v1"), disabledAt: null }} />)
    expect(enabled.container.textContent).not.toContain("disabled")
  })
})

describe("the call log", () => {
  it("shows who made each call: the playground or the key's name", () => {
    expect(callerLabel({ source: "playground" })).toBe("Playground")
    expect(callerLabel({ source: "api_key", apiKeyName: "claude-code" })).toBe("Key: claude-code")
    expect(callerLabel({ source: undefined })).toBe("—")
    render(
      <CallLogTable
        calls={[
          {
            id: 2,
            at: 0,
            tool: "t",
            status: "ok",
            durationMs: 5,
            versionId: null,
            source: "playground",
          },
          {
            id: 1,
            at: 0,
            tool: "t",
            status: "ok",
            durationMs: 5,
            versionId: null,
            source: "api_key",
            apiKeyName: "claude-code",
          },
        ]}
      />,
    )
    expect(screen.getByRole("columnheader", { name: "Caller" })).toBeTruthy()
    expect(screen.getByText("Playground")).toBeTruthy()
    expect(screen.getByText("Key: claude-code")).toBeTruthy()
  })
})
