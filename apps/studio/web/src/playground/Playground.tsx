import type { Client } from "@modelcontextprotocol/client"
import { Play, PlugZap } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { api } from "../api.js"
import {
  ErrorText,
  type LogEntry,
  RawLog,
  ToolList,
  ToolOutput,
  type ToolSummary,
} from "../components/untrusted.js"
import { Badge } from "../ui/Badge.js"
import { Button } from "../ui/Button.js"
import { Card, CardContent, CardHeader } from "../ui/Card.js"
import { CopyButton } from "../ui/Copy.js"
import { Field, Textarea } from "../ui/Field.js"
import { connectPlayground } from "./client.js"
import { argumentSkeleton } from "./skeleton.js"

interface Grant {
  token: string
  expiresAt: number
  mcpPath: string
}

/** Calls one saved version (draft or published) through the gateway, as a real client would. */
export function Playground(props: {
  serverId: string
  versionId: string | undefined
  versionNumber?: number | undefined
}) {
  const [client, setClient] = useState<Client>()
  const [tools, setTools] = useState<(ToolSummary & { inputSchema?: unknown })[]>([])
  const [selected, setSelected] = useState<string>()
  const [args, setArgs] = useState("{}")
  const [result, setResult] = useState<unknown>()
  const [log, setLog] = useState<LogEntry[]>([])
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState<"connect" | "call">()
  const nextId = useRef(0)

  // A new version means a new connection.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the version changes
  useEffect(() => {
    setTools([])
    setSelected(undefined)
    setResult(undefined)
    setClient((previous) => {
      void previous?.close()
      return undefined
    })
  }, [props.versionId])

  const append = (direction: LogEntry["direction"], text: string) => {
    const id = nextId.current++
    setLog((entries) => [...entries.slice(-99), { id, direction, text }])
  }

  const connect = async () => {
    if (!props.versionId) return
    setBusy("connect")
    setError(undefined)
    try {
      const grant = await api<Grant>(
        "POST",
        `/servers/${props.serverId}/versions/${props.versionId}/playground`,
      )
      const connected = await connectPlayground(grant.mcpPath, grant.token, append)
      setClient(connected)
      const listed = await connected.listTools()
      setTools(listed.tools)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(undefined)
    }
  }

  const call = async () => {
    if (!client || !selected) return
    setBusy("call")
    setError(undefined)
    try {
      const parsed: unknown = JSON.parse(args)
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Arguments must be a JSON object.")
      }
      setResult(
        await client.callTool({ name: selected, arguments: parsed as Record<string, unknown> }),
      )
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(undefined)
    }
  }

  // The log never holds the playground token (see client.ts).
  const transcript = log
    .map((entry) => `${entry.direction === "request" ? "→" : "←"} ${entry.text}`)
    .join("\n\n")

  return (
    <Card className="min-w-0" data-testid="playground">
      <CardHeader
        title="Playground"
        description="Try the selected version through the gateway, with a temporary 15-minute token. Clients that stay connected need an API key."
      />
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={client ? "secondary" : "primary"}
            onClick={() => void connect()}
            disabled={!props.versionId}
            loading={busy === "connect"}
            icon={<PlugZap className="size-4" aria-hidden="true" />}
          >
            {client ? "Reconnect" : "Connect"}
          </Button>
          {props.versionId === undefined ? (
            <span className="text-xs text-fg-subtle">Save a version to try it.</span>
          ) : client ? (
            <Badge tone="success" dot>
              {props.versionNumber === undefined
                ? "connected"
                : `connected to v${props.versionNumber}`}
            </Badge>
          ) : null}
        </div>
        <ErrorText error={error} />
        {client ? (
          <section aria-label="Tools" className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-fg-muted uppercase">Tools</h3>
            <ToolList
              tools={tools}
              selected={selected}
              onSelect={(name) => {
                setSelected(name)
                setArgs(argumentSkeleton(tools.find((tool) => tool.name === name)?.inputSchema))
                // The previous tool's result or error does not belong to this one.
                setResult(undefined)
                setError(undefined)
              }}
            />
          </section>
        ) : null}
        {selected ? (
          <div className="space-y-3">
            <Field label="Arguments (JSON)">
              <Textarea
                value={args}
                onChange={(event) => setArgs(event.target.value)}
                rows={5}
                spellCheck={false}
                className="font-mono text-[0.8125rem]"
              />
            </Field>
            <Button
              variant="primary"
              onClick={() => void call()}
              loading={busy === "call"}
              disabled={busy === "connect"}
              icon={<Play className="size-4" aria-hidden="true" />}
            >
              Call {selected}
            </Button>
          </div>
        ) : null}
        {result !== undefined ? (
          <section aria-label="Result" className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-fg-muted uppercase">Result</h3>
            <ToolOutput result={result} />
          </section>
        ) : null}
        <details className="group rounded-md border border-border">
          <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-sm font-medium text-fg-muted select-none hover:text-fg">
            {`Raw requests and responses (${log.length})`}
          </summary>
          <div className="space-y-2 border-t border-border p-3">
            {log.length > 0 ? (
              <CopyButton value={transcript} label="Copy" size="sm" copiedMessage="Log copied" />
            ) : (
              <p className="text-xs text-fg-subtle">Nothing yet. Connect to see the traffic.</p>
            )}
            <RawLog entries={log} />
          </div>
        </details>
      </CardContent>
    </Card>
  )
}
