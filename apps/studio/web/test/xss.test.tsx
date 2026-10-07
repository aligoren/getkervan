import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"
import {
  AuditTable,
  CallLogTable,
  DiffView,
  ErrorText,
  IssueList,
  RawLog,
  SecretTable,
  ToolList,
  ToolOutput,
} from "../src/components/untrusted.js"
import { ServerList } from "../src/pages/Servers.js"

afterEach(cleanup)

// Payloads a spec author, an upstream API or a tool could put into what Studio displays.
const PAYLOADS = [
  '<img src=x onerror="window.__pwned = 1">',
  "<script>window.__pwned = 1</script>",
  '<iframe src="javascript:window.__pwned = 1"></iframe>',
  '<svg onload="window.__pwned = 1"></svg>',
  "[click](javascript:window.__pwned=1)",
  '<a href="javascript:window.__pwned = 1">click</a>',
  "&lt;img src=x onerror=1&gt;",
]

/** No element the payload could create, no handler attribute, no javascript: URL. */
function expectInert(container: HTMLElement, payload: string) {
  // The design system's own icons are SVGs (lucide); anything else is foreign.
  const foreign = [...container.querySelectorAll("img, script, iframe, svg, object, embed")].filter(
    (element) => !(element.tagName.toLowerCase() === "svg" && element.classList.contains("lucide")),
  )
  expect(foreign).toHaveLength(0)
  for (const element of container.querySelectorAll("*")) {
    for (const attribute of element.getAttributeNames()) {
      expect(attribute.startsWith("on"), `${element.tagName} ${attribute}`).toBe(false)
    }
    const href = element.getAttribute("href") ?? ""
    expect(href.toLowerCase().includes("javascript:"), href).toBe(false)
  }
  // The payload is shown literally, as text.
  expect(container.textContent).toContain(payload)
  expect((window as { __pwned?: number }).__pwned).toBeUndefined()
}

describe.each(PAYLOADS)("untrusted text is never HTML: %s", (payload) => {
  it("in tool names, titles and descriptions", () => {
    const { container } = render(
      <ToolList tools={[{ name: payload, title: payload, description: payload }]} />,
    )
    expectInert(container, payload)
  })

  it("in tool output, text and structured", () => {
    const { container } = render(
      <ToolOutput
        result={{
          content: [
            { type: "text", text: payload },
            { type: "image", data: "aGk=", mimeType: payload },
          ],
          structuredContent: { note: payload },
        }}
      />,
    )
    expectInert(container, payload)
    // Image content is described, never rendered.
    expect(container.textContent).toContain("content, not displayed")
  })

  it("in spec issues", () => {
    const { container } = render(
      <IssueList
        issues={[{ path: [], message: payload, severity: "error", line: 1, column: 1 }]}
      />,
    )
    expectInert(container, payload)
  })

  it("in the raw request/response log", () => {
    const { container } = render(
      <RawLog entries={[{ id: 1, direction: "response", text: payload }]} />,
    )
    expectInert(container, payload)
  })

  it("in error messages", () => {
    const { container } = render(<ErrorText error={new Error(payload)} />)
    expectInert(container, payload)
  })

  it("in server names", () => {
    const { container } = render(
      <ServerList
        servers={[
          {
            id: "11111111-1111-1111-1111-111111111111",
            slug: "s",
            name: payload,
            publishedVersionId: null,
            logPayloads: false,
            createdAt: 0,
            updatedAt: 0,
          },
        ]}
      />,
    )
    expectInert(container, payload)
  })
})

describe.each(PAYLOADS)("untrusted text in 4c views is never HTML: %s", (payload) => {
  it("in version diffs", () => {
    const { container } = render(
      <DiffView
        lines={[
          { kind: "removed", text: payload },
          { kind: "added", text: payload },
        ]}
      />,
    )
    expectInert(container, payload)
  })

  it("in call logs, including logged arguments and results", () => {
    const { container } = render(
      <CallLogTable
        calls={[
          {
            id: 1,
            at: 0,
            tool: payload,
            status: "ok",
            durationMs: 1,
            versionId: null,
            args: payload,
            result: payload,
          },
        ]}
      />,
    )
    expectInert(container, payload)
  })

  it("in the audit log", () => {
    const { container } = render(
      <AuditTable
        events={[
          {
            id: 1,
            at: 0,
            actorType: "user",
            actorId: null,
            action: payload,
            targetType: null,
            targetId: null,
            ip: null,
            details: { email: payload },
          },
        ]}
      />,
    )
    // The design system's own icons are SVGs (lucide); anything else is foreign.
    const foreign = [
      ...container.querySelectorAll("img, script, iframe, svg, object, embed"),
    ].filter(
      (element) =>
        !(element.tagName.toLowerCase() === "svg" && element.classList.contains("lucide")),
    )
    expect(foreign).toHaveLength(0)
    expect(container.textContent).toContain(payload)
  })

  it("in secret usage (tool names from a spec)", () => {
    const { container } = render(
      <SecretTable
        secrets={[
          {
            name: "API_KEY",
            allowedHosts: ["api.example.com:443"],
            updatedAt: 0,
            usedBy: { version: 1, tools: [payload] },
          },
        ]}
      />,
    )
    expectInert(container, payload)
  })
})

describe("the web UI source", () => {
  // Under jsdom, import.meta.url is not a file URL; the directory still is.
  const src = path.resolve(import.meta.dirname, "../src")
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)],
    )

  it("never writes HTML from strings", () => {
    const offending = files(src).flatMap((file) => {
      const text = readFileSync(file, "utf8")
      return [
        "dangerouslySetInnerHTML",
        ".innerHTML",
        ".outerHTML",
        "insertAdjacentHTML",
        "document.write",
        "eval(",
        "new Function",
        "localStorage",
        "sessionStorage",
      ]
        .filter((needle) => text.includes(needle))
        .map((needle) => `${path.relative(src, file)}: ${needle}`)
    })
    expect(offending).toEqual([])
  })
})
