import { type FormEvent, useCallback, useEffect, useState } from "react"
import { ApiError, api, type Server, type VersionCheck, type VersionInfo } from "../api.js"
import {
  type CallLogEntry,
  CallLogTable,
  type DiffLine,
  DiffView,
  ErrorText,
  type SecretSummary,
  SecretTable,
} from "../components/untrusted.js"

const path = (serverId: string, rest = "") => `/servers/${encodeURIComponent(serverId)}${rest}`

/** Version history: compare two versions, publish one, roll back, export. */
export function VersionsPanel(props: {
  server: Server
  versions: readonly VersionInfo[]
  onOpen: (versionId: string) => void
  onChanged: () => void
}) {
  const [from, setFrom] = useState<string>()
  const [to, setTo] = useState<string>()
  const [diff, setDiff] = useState<{ lines: DiffLine[] | null }>()
  const [error, setError] = useState<unknown>()
  const [notice, setNotice] = useState<string>()
  const published = props.versions.find((v) => v.id === props.server.publishedVersionId)

  const compare = async () => {
    if (!from || !to) return
    setError(undefined)
    try {
      const data = await api<{ lines: DiffLine[] | undefined }>(
        "GET",
        path(props.server.id, `/versions/${from}/diff/${to}`),
      )
      setDiff({ lines: data.lines ?? null })
    } catch (caught) {
      setError(caught)
    }
  }

  const publish = async (version: VersionInfo) => {
    setError(undefined)
    setNotice(undefined)
    try {
      await api("POST", path(props.server.id, `/versions/${version.id}/publish`))
      setNotice(`Version ${version.number} is now published.`)
      props.onChanged()
    } catch (caught) {
      setError(caught)
    }
  }

  return (
    <section>
      <h2>Versions</h2>
      <table className="versions">
        <thead>
          <tr>
            <th>Version</th>
            <th>Saved</th>
            <th>Check</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {props.versions.map((version) => {
            const isPublished = version.id === props.server.publishedVersionId
            const older = published !== undefined && version.number < published.number
            return (
              <tr key={version.id}>
                <td>{`v${version.number}${isPublished ? " (published)" : ""}`}</td>
                <td>{new Date(version.createdAt).toLocaleString()}</td>
                <td>
                  <CheckBadge check={version.check} />
                </td>
                <td>
                  <button type="button" onClick={() => props.onOpen(version.id)}>
                    Open
                  </button>
                  {isPublished ? null : (
                    <button type="button" onClick={() => void publish(version)}>
                      {older ? `Roll back to v${version.number}` : "Publish"}
                    </button>
                  )}
                  <a href={`/api${path(props.server.id, `/versions/${version.id}/export`)}`}>
                    Export
                  </a>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {notice ? <p className="notice">{notice}</p> : null}
      <ErrorText error={error} />
      <div className="inline">
        <select value={from ?? ""} onChange={(e) => setFrom(e.target.value)} aria-label="From">
          <option value="">from…</option>
          {props.versions.map((v) => (
            <option key={v.id} value={v.id}>{`v${v.number}`}</option>
          ))}
        </select>
        <select value={to ?? ""} onChange={(e) => setTo(e.target.value)} aria-label="To">
          <option value="">to…</option>
          {props.versions.map((v) => (
            <option key={v.id} value={v.id}>{`v${v.number}`}</option>
          ))}
        </select>
        <button type="button" onClick={compare} disabled={!from || !to}>
          Compare
        </button>
      </div>
      {diff ? <DiffView lines={diff.lines} /> : null}
    </section>
  )
}

/** Secrets (admins): write-only values, host bindings, and a warning before deleting one in use. */
export function SecretsPanel(props: { serverId: string }) {
  const [secrets, setSecrets] = useState<SecretSummary[]>([])
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [hosts, setHosts] = useState("")
  const [pendingDelete, setPendingDelete] = useState<{ name: string; message: string }>()
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<unknown>()

  const load = useCallback(
    () =>
      api<{ secrets: SecretSummary[] }>("GET", path(props.serverId, "/secrets")).then(
        (data) => setSecrets(data.secrets),
        (caught: unknown) => setError(caught),
      ),
    [props.serverId],
  )
  useEffect(() => {
    void load()
  }, [load])

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    setNotice(undefined)
    try {
      await api("PUT", path(props.serverId, `/secrets/${encodeURIComponent(name)}`), {
        ...(value === "" ? {} : { value }),
        allowedHosts: hosts
          .split(",")
          .map((host) => host.trim())
          .filter((host) => host !== ""),
      })
      // The value leaves the page as soon as it is saved.
      setValue("")
      setNotice(`Saved ${name}.`)
      setName("")
      setHosts("")
      await load()
    } catch (caught) {
      setError(caught)
    }
  }

  const remove = async (secret: string, confirm = false) => {
    setError(undefined)
    try {
      await api("DELETE", path(props.serverId, `/secrets/${encodeURIComponent(secret)}`), {
        confirm,
      })
      setPendingDelete(undefined)
      await load()
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setPendingDelete({ name: secret, message: caught.message })
      } else setError(caught)
    }
  }

  return (
    <section>
      <h2>Secrets</h2>
      <p className="muted">
        Values are encrypted and can never be read back. Each secret is sent only to its allowed
        hosts (host or host:port; port 443 when omitted).
      </p>
      <SecretTable
        secrets={secrets}
        onEdit={(secret) => {
          const current = secrets.find((s) => s.name === secret)
          setName(secret)
          setHosts(current?.allowedHosts.join(", ") ?? "")
          setValue("")
        }}
        onDelete={(secret) => void remove(secret)}
      />
      {pendingDelete ? (
        <div className="callout">
          <p>{pendingDelete.message}</p>
          <button type="button" onClick={() => void remove(pendingDelete.name, true)}>
            Delete {pendingDelete.name} anyway
          </button>
          <button type="button" onClick={() => setPendingDelete(undefined)}>
            Keep it
          </button>
        </div>
      ) : null}
      <form className="stack" onSubmit={save}>
        <label>
          Secret name
          <input
            placeholder="API_KEY"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <label>
          Secret value
          <input
            type="password"
            placeholder="Leave empty to keep the current value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoComplete="new-password"
          />
        </label>
        <label>
          Allowed hosts
          <input
            placeholder="api.example.com, api.example.com:8443"
            value={hosts}
            onChange={(e) => setHosts(e.target.value)}
            required
          />
        </label>
        <button type="submit">Save secret</button>
      </form>
      {notice ? <p className="notice">{notice}</p> : null}
      <ErrorText error={error} />
    </section>
  )
}

interface KeyInfo {
  id: string
  name: string
  prefix: string
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

/** API keys (admins): created keys are shown once. */
export function KeysPanel(props: {
  serverId: string
  serverSlug?: string
  /** Called when the connect command was copied (the "next steps" list ticks it off). */
  onCommandCopied?: () => void
}) {
  const [keys, setKeys] = useState<KeyInfo[]>([])
  const [name, setName] = useState("")
  const [created, setCreated] = useState<string>()
  const [confirmRevoke, setConfirmRevoke] = useState<string>()
  const [copied, setCopied] = useState<string>()
  const [error, setError] = useState<unknown>()
  const endpoint = `${window.location.origin}/s/${encodeURIComponent(props.serverId)}/mcp`
  const command = (key: string) =>
    `claude mcp add --transport http ${props.serverSlug ?? "studio"} ${endpoint} --header "Authorization: Bearer ${key}"`
  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(label)
      if (label === "command") props.onCommandCopied?.()
    } catch {
      setCopied(undefined)
    }
  }

  const load = useCallback(
    () =>
      api<{ keys: KeyInfo[] }>("GET", path(props.serverId, "/keys")).then(
        (data) => setKeys(data.keys),
        (caught: unknown) => setError(caught),
      ),
    [props.serverId],
  )
  useEffect(() => {
    void load()
  }, [load])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    try {
      const data = await api<{ key: string }>("POST", path(props.serverId, "/keys"), { name })
      setCreated(data.key)
      setName("")
      await load()
    } catch (caught) {
      setError(caught)
    }
  }

  const revoke = async (keyId: string) => {
    setError(undefined)
    setConfirmRevoke(undefined)
    try {
      await api("DELETE", path(props.serverId, `/keys/${encodeURIComponent(keyId)}`))
      await load()
    } catch (caught) {
      setError(caught)
    }
  }

  return (
    <section>
      <h2>API keys</h2>
      <p className="muted">
        MCP endpoint: <code>{endpoint}</code>
      </p>
      {created ? (
        <div className="callout">
          <p>Copy this key now. It is not stored and will not be shown again.</p>
          <input
            readOnly
            value={created}
            aria-label="New API key"
            onFocus={(e) => e.target.select()}
          />
          <button type="button" onClick={() => void copy("key", created)}>
            {copied === "key" ? "Copied" : "Copy key"}
          </button>
          <label>
            Connect command for Claude Code
            <textarea readOnly value={command(created)} rows={3} className="command" />
          </label>
          <button type="button" onClick={() => void copy("command", command(created))}>
            {copied === "command" ? "Copied" : "Copy command"}
          </button>
          <button
            type="button"
            onClick={() => {
              setCreated(undefined)
              setCopied(undefined)
            }}
          >
            Done
          </button>
        </div>
      ) : null}
      <table className="keys">
        <thead>
          <tr>
            <th>Name</th>
            <th>Key</th>
            <th>Created</th>
            <th>Last used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key.id} className={key.revokedAt ? "revoked" : undefined}>
              <td>{key.name}</td>
              <td>
                <code>{`${key.prefix}…`}</code>
              </td>
              <td>{new Date(key.createdAt).toLocaleString()}</td>
              <td>{key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : "never"}</td>
              <td>
                {key.revokedAt ? (
                  "revoked"
                ) : confirmRevoke === key.id ? (
                  <>
                    <button type="button" onClick={() => void revoke(key.id)}>
                      Revoke now
                    </button>
                    <button type="button" onClick={() => setConfirmRevoke(undefined)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={() => setConfirmRevoke(key.id)}>
                    Revoke
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form className="inline" onSubmit={create}>
        <label className="grow">
          Key name
          <input
            placeholder="e.g. claude-code"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <button type="submit">Create key</button>
      </form>
      <ErrorText error={error} />
    </section>
  )
}

/** Recent calls; admins can opt in to logging (redacted, cut) arguments and results. */
export function LogsPanel(props: { server: Server; isAdmin: boolean; onChanged: () => void }) {
  const [calls, setCalls] = useState<CallLogEntry[]>([])
  const [error, setError] = useState<unknown>()

  const load = useCallback(
    () =>
      api<{ calls: CallLogEntry[] }>("GET", path(props.server.id, "/logs")).then(
        (data) => setCalls(data.calls),
        (caught: unknown) => setError(caught),
      ),
    [props.server.id],
  )
  useEffect(() => {
    void load()
  }, [load])

  const toggle = async () => {
    setError(undefined)
    try {
      await api("PUT", path(props.server.id, "/settings"), {
        logPayloads: !props.server.logPayloads,
      })
      props.onChanged()
    } catch (caught) {
      setError(caught)
    }
  }

  return (
    <section>
      <h2>Calls</h2>
      <div className="inline">
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
        {props.isAdmin ? (
          <label className="checkbox">
            <input type="checkbox" checked={props.server.logPayloads} onChange={toggle} />
            Also log arguments and results (redacted, cut to 4 KiB)
          </label>
        ) : null}
      </div>
      <CallLogTable calls={calls} />
      <ErrorText error={error} />
    </section>
  )
}

/** A version's latest validation: valid, has problems, or not checked yet. */
export function CheckBadge(props: { check: VersionCheck | null | undefined }) {
  if (!props.check) return <span className="badge">not checked</span>
  if (props.check.valid) return <span className="badge ok">valid</span>
  return (
    <span className="badge bad">
      {`${props.check.problems} problem${props.check.problems === 1 ? "" : "s"}`}
    </span>
  )
}
