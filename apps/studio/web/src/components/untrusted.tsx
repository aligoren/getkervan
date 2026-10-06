// Everything on this page that comes from a spec author, an upstream API or a tool is untrusted.
// It is only ever rendered as React text children: never as HTML, Markdown, a link or an image.
import type { Issue } from "../api.js"

export interface ToolSummary {
  name: string
  title?: string | undefined
  description?: string | undefined
}

export function ToolList(props: {
  tools: readonly ToolSummary[]
  selected?: string | undefined
  onSelect?: (name: string) => void
}) {
  if (props.tools.length === 0) return <p className="muted">No tools.</p>
  return (
    <ul className="tools">
      {props.tools.map((tool) => (
        <li key={tool.name} className={tool.name === props.selected ? "selected" : undefined}>
          <button type="button" onClick={() => props.onSelect?.(tool.name)}>
            <span className="tool-name">{tool.title ?? tool.name}</span>
          </button>
          {tool.description ? <p className="tool-description">{tool.description}</p> : null}
        </li>
      ))}
    </ul>
  )
}

interface ContentBlock {
  type: string
  text?: string
  mimeType?: string
}

/** A tool result: text blocks as preformatted text; other content only described, never shown. */
export function ToolOutput(props: { result: unknown }) {
  const result = props.result as {
    content?: ContentBlock[]
    structuredContent?: unknown
    isError?: boolean
  }
  return (
    <div className={result.isError ? "output error" : "output"}>
      {result.isError ? <p className="label">The tool returned an error:</p> : null}
      {(result.content ?? []).map((block, index) =>
        block.type === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity of their own
          <pre key={index}>{block.text ?? ""}</pre>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity of their own
          <p key={index} className="muted">
            {`[${block.type}${block.mimeType ? ` ${block.mimeType}` : ""} content, not displayed]`}
          </p>
        ),
      )}
      {result.structuredContent !== undefined ? (
        <>
          <p className="label">Structured content:</p>
          <pre>{JSON.stringify(result.structuredContent, null, 2)}</pre>
        </>
      ) : null}
    </div>
  )
}

export function IssueList(props: { issues: readonly Issue[] }) {
  if (props.issues.length === 0) return null
  return (
    <ul className="issues">
      {props.issues.map((issue, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: issues can repeat exactly
        <li key={index} className={issue.severity}>
          <span className="where">
            {issue.line === undefined ? "" : `${issue.line}:${issue.column ?? 1} `}
          </span>
          {issue.message}
        </li>
      ))}
    </ul>
  )
}

export interface LogEntry {
  id: number
  direction: "request" | "response"
  text: string
}

/** The raw JSON-RPC traffic of the playground, as text. */
export function RawLog(props: { entries: readonly LogEntry[] }) {
  return (
    <ol className="raw-log">
      {props.entries.map((entry) => (
        <li key={entry.id} className={entry.direction}>
          <span className="label">
            {entry.direction === "request" ? "→ request" : "← response"}
          </span>
          <pre>{entry.text}</pre>
        </li>
      ))}
    </ol>
  )
}

/** An error message from the API or the MCP client. */
export function ErrorText(props: { error: unknown }) {
  if (!props.error) return null
  const message = props.error instanceof Error ? props.error.message : String(props.error)
  return <p className="error-text">{message}</p>
}
