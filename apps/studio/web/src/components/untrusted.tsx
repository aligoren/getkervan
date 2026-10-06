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

export interface DiffLine {
  kind: "same" | "added" | "removed"
  text: string
}

/** A line diff between two spec versions, as text. */
export function DiffView(props: { lines: readonly DiffLine[] | null }) {
  if (props.lines === null) return <p className="muted">These versions are too large to compare.</p>
  return (
    <pre className="diff">
      {props.lines.map((line, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines can repeat
        <span key={index} className={`diff-${line.kind}`}>
          {`${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "} ${line.text}\n`}
        </span>
      ))}
    </pre>
  )
}

export interface CallLogEntry {
  id: number
  at: number
  tool: string
  status: "ok" | "error"
  durationMs: number
  versionId: string | null
  args?: string | undefined
  result?: string | undefined
}

/** Recent tool calls. Arguments and results (opt-in, admins only) come from clients and upstreams. */
export function CallLogTable(props: { calls: readonly CallLogEntry[] }) {
  if (props.calls.length === 0) return <p className="muted">No calls yet.</p>
  return (
    <table className="calls">
      <thead>
        <tr>
          <th>Time</th>
          <th>Tool</th>
          <th>Status</th>
          <th>Duration</th>
          <th>Payload</th>
        </tr>
      </thead>
      <tbody>
        {props.calls.map((call) => (
          <tr key={call.id} className={call.status}>
            <td>{new Date(call.at).toLocaleString()}</td>
            <td>{call.tool}</td>
            <td>{call.status}</td>
            <td>{`${call.durationMs} ms`}</td>
            <td>
              {call.args !== undefined ? <pre>{`args: ${call.args}`}</pre> : null}
              {call.result !== undefined ? <pre>{`result: ${call.result}`}</pre> : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export interface AuditEntry {
  id: number
  at: number
  actorType: string
  actorId: string | null
  action: string
  targetType: string | null
  targetId: string | null
  ip: string | null
  details: Record<string, unknown> | null
}

export function AuditTable(props: { events: readonly AuditEntry[] }) {
  if (props.events.length === 0) return <p className="muted">No events.</p>
  return (
    <table className="audit">
      <thead>
        <tr>
          <th>Time</th>
          <th>Action</th>
          <th>Actor</th>
          <th>Target</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        {props.events.map((event) => (
          <tr key={event.id}>
            <td>{new Date(event.at).toLocaleString()}</td>
            <td>{event.action}</td>
            <td>{`${event.actorType}${event.actorId ? ` ${event.actorId.slice(0, 8)}` : ""}${event.ip ? ` from ${event.ip}` : ""}`}</td>
            <td>
              {event.targetType ? `${event.targetType} ${event.targetId?.slice(0, 8) ?? ""}` : ""}
            </td>
            <td>
              <code>{event.details ? JSON.stringify(event.details) : ""}</code>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export interface SecretSummary {
  name: string
  allowedHosts: string[]
  updatedAt: number
  usedBy: { version: number; tools: string[] } | null
}

/** Secret names and bindings (never values), and which published tools use them. */
export function SecretTable(props: {
  secrets: readonly SecretSummary[]
  onEdit?: (name: string) => void
  onDelete?: (name: string) => void
}) {
  if (props.secrets.length === 0) return <p className="muted">No secrets.</p>
  return (
    <table className="secrets">
      <thead>
        <tr>
          <th>Name</th>
          <th>Allowed hosts</th>
          <th>Used by</th>
          <th>Updated</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {props.secrets.map((secret) => (
          <tr key={secret.name}>
            <td>
              <code>{secret.name}</code>
            </td>
            <td>{secret.allowedHosts.join(", ")}</td>
            <td>
              {secret.usedBy
                ? `v${secret.usedBy.version}: ${secret.usedBy.tools.join(", ")}`
                : "not used by the published version"}
            </td>
            <td>{new Date(secret.updatedAt).toLocaleString()}</td>
            <td>
              <button type="button" onClick={() => props.onEdit?.(secret.name)}>
                Edit
              </button>
              <button type="button" onClick={() => props.onDelete?.(secret.name)}>
                Delete
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
