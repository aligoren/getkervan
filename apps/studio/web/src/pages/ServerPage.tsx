import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { ApiError, api, type Issue, type Server, type User, type VersionInfo } from "../api.js"
import { ErrorText, IssueList } from "../components/untrusted.js"
import { Playground } from "../playground/Playground.js"
import { STARTER_SPEC } from "../starter.js"
import { NextSteps, rememberCommandCopied } from "./NextSteps.js"
import { KeysPanel, LogsPanel, SecretsPanel, VersionsPanel } from "./ServerPanels.js"

// Monaco is large; load it only here.
const SpecEditor = lazy(() => import("../editor/SpecEditor.js"))

type Tab = "editor" | "versions" | "secrets" | "keys" | "logs"

export function ServerPage(props: { serverId: string; user: User }) {
  const [tab, setTab] = useState<Tab>("editor")
  const isAdmin = props.user.role === "admin"
  const [server, setServer] = useState<Server>()
  const [versions, setVersions] = useState<VersionInfo[]>([])
  const [selected, setSelected] = useState<string>()
  const [text, setText] = useState(STARTER_SPEC)
  // Bumped whenever the "next steps" may have changed.
  const [refresh, setRefresh] = useState(0)
  const bump = () => setRefresh((n) => n + 1)
  const [issues, setIssues] = useState<Issue[]>([])
  const [error, setError] = useState<unknown>()
  const [notice, setNotice] = useState<string>()

  const load = useCallback(async () => {
    const data = await api<{ server: Server; versions: VersionInfo[] }>(
      "GET",
      `/servers/${encodeURIComponent(props.serverId)}`,
    )
    setServer(data.server)
    setVersions(data.versions)
    return data
  }, [props.serverId])

  const open = useCallback(
    async (versionId: string) => {
      const data = await api<{ version: { yamlText: string } }>(
        "GET",
        `/servers/${encodeURIComponent(props.serverId)}/versions/${encodeURIComponent(versionId)}`,
      )
      setSelected(versionId)
      setText(data.version.yamlText)
      setIssues([])
    },
    [props.serverId],
  )

  useEffect(() => {
    load().then(
      (data) => {
        const first = data.server.publishedVersionId ?? data.versions[0]?.id
        if (first) return open(first)
      },
      (caught: unknown) => setError(caught),
    )
  }, [load, open])

  const save = async () => {
    setError(undefined)
    setNotice(undefined)
    try {
      const saved = await api<{ version: VersionInfo; valid: boolean; issues: Issue[] }>(
        "POST",
        `/servers/${encodeURIComponent(props.serverId)}/versions`,
        { yaml: text },
      )
      setIssues(saved.issues)
      setSelected(saved.version.id)
      setNotice(
        saved.valid
          ? `Saved version ${saved.version.number}. It can be published.`
          : `Saved version ${saved.version.number} as a draft with problems.`,
      )
      await load()
      bump()
    } catch (caught) {
      setError(caught)
    }
  }

  const publish = async () => {
    if (!selected) return
    setError(undefined)
    setNotice(undefined)
    try {
      const done = await api<{ published: { number: number } }>(
        "POST",
        `/servers/${encodeURIComponent(props.serverId)}/versions/${encodeURIComponent(selected)}/publish`,
      )
      setNotice(`Version ${done.published.number} is published.`)
      await load()
      bump()
    } catch (caught) {
      if (caught instanceof ApiError) setIssues(caught.issues)
      setError(caught)
    }
  }

  if (!server) return <ErrorText error={error} />
  const tabs: [Tab, string][] = [
    ["editor", "Editor"],
    ["versions", "Versions"],
    ...(isAdmin
      ? ([
          ["secrets", "Secrets"],
          ["keys", "API keys"],
        ] as [Tab, string][])
      : []),
    ["logs", "Calls"],
  ]
  const reload = () => void load().catch((caught: unknown) => setError(caught))
  const exportUrl = selected
    ? `/api/servers/${encodeURIComponent(server.id)}/versions/${encodeURIComponent(selected)}/export`
    : undefined

  return (
    <section className="server">
      <header>
        <a href="#/">Servers</a> / <strong>{server.name}</strong>{" "}
        <span className="muted">
          MCP endpoint: <code>{`${window.location.origin}/s/${server.id}/mcp`}</code>
        </span>
      </header>
      <nav className="tabs">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? "active" : undefined}
            onClick={() => {
              setTab(id)
              bump()
            }}
          >
            {label}
          </button>
        ))}
      </nav>
      <NextSteps serverId={server.id} isAdmin={isAdmin} refresh={refresh} />
      {tab === "versions" ? (
        <VersionsPanel
          server={server}
          versions={versions}
          onOpen={(versionId) => {
            setTab("editor")
            void open(versionId)
          }}
          onChanged={reload}
        />
      ) : null}
      {tab === "secrets" ? <SecretsPanel serverId={server.id} /> : null}
      {tab === "keys" ? (
        <KeysPanel
          serverId={server.id}
          serverSlug={server.slug}
          onCommandCopied={() => {
            rememberCommandCopied(server.id)
            bump()
          }}
        />
      ) : null}
      {tab === "logs" ? <LogsPanel server={server} isAdmin={isAdmin} onChanged={reload} /> : null}
      <div className="columns" hidden={tab !== "editor"}>
        <div className="main">
          <div className="toolbar">
            <label>
              Version{" "}
              <select value={selected ?? ""} onChange={(e) => void open(e.target.value)}>
                <option value="" disabled>
                  (unsaved)
                </option>
                {versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {`v${version.number}${version.id === server.publishedVersionId ? " (published)" : ""}`}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" onClick={save}>
              Save as new version
            </button>
            <button type="button" onClick={publish} disabled={!selected}>
              Publish selected version
            </button>
            {exportUrl ? <a href={exportUrl}>Export kervan.yaml</a> : null}
          </div>
          {notice ? <p className="notice">{notice}</p> : null}
          <ErrorText error={error} />
          <Suspense fallback={<p className="muted">Loading editor…</p>}>
            <SpecEditor value={text} onChange={setText} issues={issues} />
          </Suspense>
          <IssueList issues={issues} />
        </div>
        <aside>
          <Playground serverId={server.id} versionId={selected} />
        </aside>
      </div>
    </section>
  )
}
