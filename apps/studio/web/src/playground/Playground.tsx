import type { Client } from "@modelcontextprotocol/client"
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
import { connectPlayground } from "./client.js"

interface Grant {
  token: string
  expiresAt: number
  mcpPath: string
}

/** Calls one saved version (draft or published) through the gateway, as a real client would. */
export function Playground(props: { serverId: string; versionId: string | undefined }) {
  const [client, setClient] = useState<Client>()
  const [tools, setTools] = useState<ToolSummary[]>([])
  const [selected, setSelected] = useState<string>()
  const [args, setArgs] = useState("{}")
  const [result, setResult] = useState<unknown>()
  const [log, setLog] = useState<LogEntry[]>([])
  const [error, setError] = useState<unknown>()
  const [busy, setBusy] = useState(false)
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
    setBusy(true)
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
      setBusy(false)
    }
  }

  const call = async () => {
    if (!client || !selected) return
    setBusy(true)
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
      setBusy(false)
    }
  }

  return (
    <section className="playground">
      <h2>Playground</h2>
      <p className="muted">
        Calls the selected version through the gateway with a 15-minute token, like any MCP client.
      </p>
      <button type="button" onClick={connect} disabled={!props.versionId || busy}>
        {client ? "Reconnect" : "Connect"}
      </button>
      <ErrorText error={error} />
      <ToolList tools={tools} selected={selected} onSelect={setSelected} />
      {selected ? (
        <div className="call">
          <label>
            Arguments (JSON)
            <textarea
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              rows={5}
              spellCheck={false}
            />
          </label>
          <button type="button" onClick={call} disabled={busy}>
            Call {selected}
          </button>
        </div>
      ) : null}
      {result !== undefined ? <ToolOutput result={result} /> : null}
      <details>
        <summary>Raw requests and responses ({log.length})</summary>
        <RawLog entries={log} />
      </details>
    </section>
  )
}
