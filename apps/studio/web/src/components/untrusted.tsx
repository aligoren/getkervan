// Everything on this page that comes from a spec author, an upstream API or a tool is untrusted.
// It is only ever rendered as React text children: never as HTML, Markdown, a link or an image,
// and invisible or control characters in it are shown as marked escapes (`Visible`).
import { ArrowDownLeft, ArrowUpRight, CircleAlert, ScrollText, TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"
import type { Issue } from "../api.js"
import { shortTime } from "../time.js"
import { Badge } from "../ui/Badge.js"
import { cn } from "../ui/cn.js"
import { Alert, EmptyState } from "../ui/Layout.js"
import { EmptyRow, Table, TBody, TD, TH, THead, TR } from "../ui/Table.js"

/** A backslash and "u", as an escape starts. */
const BACKSLASH_U = String.fromCharCode(92, 117)
/** Letters and symbols that draw as nothing: Hangul fillers, the braille blank, U+180E. */
const BLANK_LOOKING = [0x115f, 0x1160, 0x3164, 0xffa0, 0x2800, 0x180e]
/** Controls, format characters (bidi, zero-width, tag characters, ...), separators, blanks. */
const HIDDEN = new RegExp(
  `[\\p{Cc}\\p{Cf}\\p{Zl}\\p{Zp}${String.fromCodePoint(...BLANK_LOOKING)}]`,
  "u",
)
/** Shown as they are: line feed and tab (text has lines), ZWNJ and ZWJ (scripts, emoji). */
const KEPT = new Set([0x0a, 0x09, 0x200c, 0x200d])

/**
 * Untrusted text with every invisible or control character shown as a marked escape (a
 * backslash, "u" and its code point): a right-to-left override cannot reorder what a reviewer
 * reads, and tag characters cannot carry text only a model sees.
 */
export function Visible(props: { text: string }) {
  const parts: ReactNode[] = []
  let plain = ""
  for (const character of props.text) {
    const codePoint = character.codePointAt(0) ?? 0
    if (!HIDDEN.test(character) || KEPT.has(codePoint)) {
      plain += character
      continue
    }
    if (plain) parts.push(plain)
    plain = ""
    const hex = codePoint.toString(16).toUpperCase().padStart(4, "0")
    parts.push(
      <span
        key={parts.length}
        className="rounded-sm bg-warning-subtle px-0.5 font-mono text-warning"
        title={`Hidden character U+${hex}`}
      >
        {codePoint > 0xffff ? `${BACKSLASH_U}{${hex}}` : `${BACKSLASH_U}${hex}`}
      </span>,
    )
  }
  if (plain) parts.push(plain)
  return <>{parts}</>
}

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
  if (props.tools.length === 0) return <p className="text-sm text-fg-subtle">No tools.</p>
  return (
    <ul className="space-y-1.5">
      {props.tools.map((tool) => {
        const selected = tool.name === props.selected
        return (
          <li key={tool.name}>
            <button
              type="button"
              onClick={() => props.onSelect?.(tool.name)}
              aria-pressed={selected}
              className={cn(
                "w-full cursor-pointer rounded-md border px-3 py-2 text-left transition-colors duration-150",
                selected
                  ? "border-accent bg-accent-subtle"
                  : "border-border bg-control hover:bg-control-hover",
              )}
            >
              <span className="block text-sm font-medium text-fg">
                <Visible text={tool.title ?? tool.name} />
              </span>
              {tool.title ? (
                <span className="block font-mono text-xs text-fg-subtle">{tool.name}</span>
              ) : null}
              {tool.description ? (
                <span className="mt-0.5 block text-xs whitespace-pre-wrap text-fg-muted">
                  <Visible text={tool.description} />
                </span>
              ) : null}
            </button>
          </li>
        )
      })}
    </ul>
  )
}

interface ContentBlock {
  type: string
  text?: string
  mimeType?: string
}

const pre =
  "max-h-96 overflow-auto rounded-md border border-border bg-subtle px-3 py-2.5 font-mono text-[0.8125rem] leading-relaxed whitespace-pre-wrap text-fg [overflow-wrap:anywhere]"

/** A tool result: text blocks as preformatted text; other content only described, never shown. */
export function ToolOutput(props: { result: unknown }) {
  const result = props.result as {
    content?: ContentBlock[]
    structuredContent?: unknown
    isError?: boolean
  }
  return (
    <div className="space-y-2">
      {result.isError ? (
        <p className="flex items-center gap-1.5 text-sm font-medium text-danger">
          <CircleAlert className="size-4" aria-hidden="true" /> The tool returned an error:
        </p>
      ) : null}
      {(result.content ?? []).map((block, index) =>
        block.type === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity of their own
          <pre key={index} className={cn(pre, result.isError && "border-danger/40")}>
            <Visible text={block.text ?? ""} />
          </pre>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks have no identity of their own
          <p key={index} className="text-sm text-fg-subtle">
            {`[${block.type}${block.mimeType ? ` ${block.mimeType}` : ""} content, not displayed]`}
          </p>
        ),
      )}
      {result.structuredContent !== undefined ? (
        <>
          <p className="text-xs font-medium text-fg-muted">Structured content</p>
          <pre className={pre}>
            <Visible text={JSON.stringify(result.structuredContent, null, 2)} />
          </pre>
        </>
      ) : null}
    </div>
  )
}

export function IssueList(props: { issues: readonly Issue[] }) {
  if (props.issues.length === 0) return null
  return (
    <ul className="space-y-1 rounded-lg border border-border bg-surface p-3 text-sm">
      {props.issues.map((issue, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: issues can repeat exactly
        <li key={index} className="flex items-start gap-2" data-severity={issue.severity}>
          {issue.severity === "error" ? (
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-label="Error" />
          ) : (
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Warning" />
          )}
          <span className="min-w-0">
            {issue.line === undefined ? null : (
              <span className="mr-1.5 font-mono text-xs text-fg-subtle">
                {`${issue.line}:${issue.column ?? 1}`}
              </span>
            )}
            <span className={issue.severity === "error" ? "text-danger" : "text-warning"}>
              <Visible text={issue.message} />
            </span>
          </span>
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
    <ol className="space-y-2">
      {props.entries.map((entry) => (
        <li key={entry.id}>
          <span className="mb-1 flex items-center gap-1 text-xs font-medium text-fg-muted">
            {entry.direction === "request" ? (
              <ArrowUpRight className="size-3.5" aria-hidden="true" />
            ) : (
              <ArrowDownLeft className="size-3.5" aria-hidden="true" />
            )}
            {entry.direction === "request" ? "request" : "response"}
          </span>
          <pre className={cn(pre, "max-h-64 text-xs")}>
            <Visible text={entry.text} />
          </pre>
        </li>
      ))}
    </ol>
  )
}

/** An error message from the API or the MCP client. */
export function ErrorText(props: { error: unknown; className?: string }) {
  if (!props.error) return null
  const message = props.error instanceof Error ? props.error.message : String(props.error)
  return (
    <Alert tone="danger" className={props.className}>
      <Visible text={message} />
    </Alert>
  )
}

export interface DiffLine {
  kind: "same" | "added" | "removed"
  text: string
}

/** A line diff between two spec versions, as text. */
export function DiffView(props: { lines: readonly DiffLine[] | null }) {
  if (props.lines === null) {
    return <p className="text-sm text-fg-subtle">These versions are too large to compare.</p>
  }
  return (
    <pre className="max-h-[32rem] overflow-auto rounded-lg border border-border bg-surface py-2 font-mono text-[0.8125rem] leading-relaxed">
      {props.lines.map((line, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: lines can repeat
          key={index}
          className={cn(
            "block px-3 whitespace-pre-wrap [overflow-wrap:anywhere]",
            line.kind === "added" && "bg-success-subtle text-success",
            line.kind === "removed" && "bg-danger-subtle text-danger",
            line.kind === "same" && "text-fg-muted",
          )}
        >
          <Visible
            text={`${line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "} ${line.text}`}
          />
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
  /** Who called; the API key by its name (the key itself never leaves the server). */
  source?: "playground" | "api_key" | undefined
  apiKeyName?: string | undefined
}

/** Who made a call, for the log: "Playground", the API key's name, or "—" for old entries. */
export function callerLabel(call: Pick<CallLogEntry, "source" | "apiKeyName">): string {
  if (call.source === "playground") return "Playground"
  if (call.source === "api_key") return call.apiKeyName ? `Key: ${call.apiKeyName}` : "API key"
  return "—"
}

/** Recent tool calls. Arguments and results (opt-in, admins only) come from clients and upstreams. */
export function CallLogTable(props: { calls: readonly CallLogEntry[] }) {
  const payloads = props.calls.some((call) => call.args !== undefined || call.result !== undefined)
  return (
    <Table aria-label="Calls" dense>
      <THead>
        <tr>
          <TH>Time</TH>
          <TH>Tool</TH>
          <TH>Caller</TH>
          <TH>Status</TH>
          <TH className="hidden text-right sm:table-cell">Duration</TH>
          {payloads ? <TH>Payload</TH> : null}
        </tr>
      </THead>
      <TBody>
        {props.calls.length === 0 ? (
          <EmptyRow colSpan={payloads ? 6 : 5}>
            No calls yet. Calls from clients and the playground show up here.
          </EmptyRow>
        ) : (
          props.calls.map((call) => (
            <TR key={call.id} className="[&_td]:align-top">
              <TD className="whitespace-nowrap text-fg-muted">{shortTime(call.at)}</TD>
              <TD className="font-mono text-xs">{call.tool}</TD>
              <TD className="whitespace-nowrap text-fg-muted">{callerLabel(call)}</TD>
              <TD>
                {call.status === "ok" ? (
                  <Badge tone="success" dot>
                    ok
                  </Badge>
                ) : (
                  <Badge tone="danger" dot>
                    error
                  </Badge>
                )}
              </TD>
              <TD className="hidden text-right whitespace-nowrap tabular-nums text-fg-muted sm:table-cell">{`${call.durationMs} ms`}</TD>
              {payloads ? (
                <TD className="w-full max-w-md min-w-64">
                  {call.args !== undefined || call.result !== undefined ? (
                    <details className="group">
                      <summary className="cursor-pointer truncate font-mono text-xs text-fg-muted select-none hover:text-fg">
                        <Visible text={call.args ?? "(no arguments logged)"} />
                      </summary>
                      {call.args !== undefined ? (
                        <pre className={cn(pre, "mt-2 max-h-40 text-xs")}>
                          <Visible text={`args: ${call.args}`} />
                        </pre>
                      ) : null}
                      {call.result !== undefined ? (
                        <pre className={cn(pre, "mt-1 max-h-40 text-xs")}>
                          <Visible text={`result: ${call.result}`} />
                        </pre>
                      ) : null}
                    </details>
                  ) : (
                    <span className="text-xs text-fg-subtle">not logged</span>
                  )}
                </TD>
              ) : null}
            </TR>
          ))
        )}
      </TBody>
    </Table>
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

function actionTone(action: string) {
  if (/failure|refused|revoke|disable|delete|reset/.test(action)) return "warning" as const
  if (/login\.success|enable|create|publish|setup/.test(action)) return "success" as const
  return "neutral" as const
}

/** An audit detail value as short text: strings as they are, anything else as JSON. */
function detailText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

/**
 * The audit log. `names` maps ids the viewer can resolve (users' emails, servers' names) to
 * readable labels; unknown ids show their first 8 characters.
 */
export function AuditTable(props: {
  events: readonly AuditEntry[]
  names?: ReadonlyMap<string, string>
}) {
  const name = (id: string) => props.names?.get(id) ?? id.slice(0, 8)
  const label = (type: string | null, id: string | null) => {
    if (!type) return ""
    return id ? `${type} ${name(id)}` : type
  }
  // A long id in the details reads as its name, or its first 8 characters.
  const detail = (value: unknown) =>
    typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(value)
      ? name(value)
      : detailText(value)
  if (props.events.length === 0) {
    return (
      <EmptyState
        icon={<ScrollText className="size-5" />}
        title="No events yet"
        description="Sign-ins, user and profile changes, servers, secrets and API keys are recorded here."
      />
    )
  }
  return (
    <Table aria-label="Audit log" dense>
      <THead>
        <tr>
          <TH>Time</TH>
          <TH>Action</TH>
          <TH>Actor</TH>
          <TH>Target</TH>
          <TH>Details</TH>
        </tr>
      </THead>
      <TBody>
        {props.events.map((event) => (
          <TR key={event.id}>
            <TD className="whitespace-nowrap text-fg-muted">{shortTime(event.at)}</TD>
            <TD>
              <Badge tone={actionTone(event.action)}>{event.action}</Badge>
            </TD>
            <TD className="min-w-52 break-words">
              <span>
                {event.actorType === "user" && event.actorId
                  ? name(event.actorId)
                  : label(event.actorType, event.actorId)}
              </span>
              {event.ip ? (
                <span className="block text-xs text-fg-subtle">{`from ${event.ip}`}</span>
              ) : null}
            </TD>
            <TD className="min-w-44 break-words text-fg-muted">
              {label(event.targetType, event.targetId)}
            </TD>
            <TD className="min-w-56">
              {event.details ? (
                <dl className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
                  {Object.entries(event.details).map(([key, value]) => (
                    <div key={key} className="flex min-w-0 gap-1">
                      <dt className="text-fg-subtle">{key}</dt>
                      <dd className="font-mono break-all text-fg-muted">{detail(value)}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
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
  return (
    <Table aria-label="Secrets">
      <THead>
        <tr>
          <TH>Name</TH>
          <TH className="hidden sm:table-cell">Allowed hosts</TH>
          <TH className="hidden md:table-cell">Used by</TH>
          <TH className="hidden lg:table-cell">Updated</TH>
          <TH className="w-px">
            <span className="visually-hidden">Actions</span>
          </TH>
        </tr>
      </THead>
      <TBody>
        {props.secrets.length === 0 ? (
          <EmptyRow colSpan={5}>
            No secrets. Add one when a tool's spec uses {"{{secrets.NAME}}"}.
          </EmptyRow>
        ) : (
          props.secrets.map((secret) => (
            <TR key={secret.name}>
              <TD>
                <code className="font-mono text-xs font-medium">{secret.name}</code>
                <div className="mt-1 flex flex-wrap gap-1 sm:hidden">
                  {secret.allowedHosts.map((host) => (
                    <Badge key={host}>{host}</Badge>
                  ))}
                </div>
              </TD>
              <TD className="hidden sm:table-cell">
                <div className="flex flex-wrap gap-1">
                  {secret.allowedHosts.map((host) => (
                    <Badge key={host}>{host}</Badge>
                  ))}
                </div>
              </TD>
              <TD className="hidden text-fg-muted md:table-cell">
                {secret.usedBy
                  ? `v${secret.usedBy.version}: ${secret.usedBy.tools.join(", ")}`
                  : "Not used by the published version"}
              </TD>
              <TD className="hidden whitespace-nowrap text-fg-muted lg:table-cell">
                {shortTime(secret.updatedAt)}
              </TD>
              <TD>
                <div className="flex justify-end gap-1">
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-xs font-medium text-fg-muted transition-colors hover:bg-subtle hover:text-fg"
                    onClick={() => props.onEdit?.(secret.name)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-xs font-medium text-danger transition-colors hover:bg-danger-subtle"
                    onClick={() => props.onDelete?.(secret.name)}
                  >
                    Delete
                  </button>
                </div>
              </TD>
            </TR>
          ))
        )}
      </TBody>
    </Table>
  )
}
