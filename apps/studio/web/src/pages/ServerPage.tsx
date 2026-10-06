import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { ApiError, api, type Issue, type Server, type VersionInfo } from "../api.js"
import { ErrorText, IssueList } from "../components/untrusted.js"
import { Playground } from "../playground/Playground.js"

// Monaco is large; load it only here.
const SpecEditor = lazy(() => import("../editor/SpecEditor.js"))

const STARTER = `specVersion: 1
name: my-server
version: 0.1.0
tools:
  - name: example
    description: Describe what the tool does.
    http:
      url: https://api.example.com/items
    output:
      select: "items[].{id: id, name: name}"
`

export function ServerPage(props: { serverId: string }) {
  const [server, setServer] = useState<Server>()
  const [versions, setVersions] = useState<VersionInfo[]>([])
  const [selected, setSelected] = useState<string>()
  const [text, setText] = useState(STARTER)
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
    } catch (caught) {
      if (caught instanceof ApiError) setIssues(caught.issues)
      setError(caught)
    }
  }

  if (!server) return <ErrorText error={error} />
  const exportUrl = selected
    ? `/api/servers/${encodeURIComponent(server.id)}/versions/${encodeURIComponent(selected)}/export`
    : undefined

  return (
    <section className="server">
      <header>
        <a href="#/">Servers</a> / <strong>{server.name}</strong>{" "}
        <span className="muted">MCP endpoint: /s/{server.id}/mcp</span>
      </header>
      <div className="columns">
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
