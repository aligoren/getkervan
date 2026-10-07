import { Download, Loader2, Save, Upload } from "lucide-react"
import { lazy, Suspense, useCallback, useEffect, useState } from "react"
import { ApiError, api, type Issue, type Server, type User, type VersionInfo } from "../api.js"
import { ErrorText, IssueList } from "../components/untrusted.js"
import { Playground } from "../playground/Playground.js"
import { STARTER_SPEC } from "../starter.js"
import { Badge } from "../ui/Badge.js"
import { Button, buttonClass } from "../ui/Button.js"
import { CopyButton } from "../ui/Copy.js"
import { Alert, PageHeader, Skeleton } from "../ui/Layout.js"
import { Select, TabPanel, Tabs } from "../ui/Radix.js"
import { useToast } from "../ui/Toast.js"
import { NextSteps, rememberCommandCopied } from "./NextSteps.js"
import { KeysPanel, LogsPanel, SecretsPanel, VersionsPanel } from "./ServerPanels.js"
import { StatusBadges } from "./Servers.js"

// Monaco is large; load it only here.
const SpecEditor = lazy(() => import("../editor/SpecEditor.js"))

type Tab = "editor" | "versions" | "secrets" | "keys" | "logs"

function EditorLoading() {
  return (
    <div className="flex h-[60vh] min-h-80 items-center justify-center gap-2 text-sm text-fg-subtle">
      <Loader2 className="size-4 animate-spin" aria-hidden="true" /> Loading editor…
    </div>
  )
}

export function ServerPage(props: { serverId: string; user: User }) {
  const notify = useToast()
  const [tab, setTab] = useState<Tab>("editor")
  const isAdmin = props.user.role === "admin"
  const [server, setServer] = useState<Server>()
  const [versions, setVersions] = useState<VersionInfo[]>([])
  const [selected, setSelected] = useState<string>()
  const [text, setText] = useState(STARTER_SPEC)
  // The text of the opened version, as saved.
  const [savedText, setSavedText] = useState<string>()
  // Bumped whenever the "next steps" may have changed.
  const [refresh, setRefresh] = useState(0)
  const bump = () => setRefresh((n) => n + 1)
  const [issues, setIssues] = useState<Issue[]>([])
  const [busy, setBusy] = useState<"save" | "publish">()
  const [error, setError] = useState<unknown>()
  const [result, setResult] = useState<{ tone: "success" | "warning"; text: string }>()

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
      setSavedText(data.version.yamlText)
      setIssues([])
      setResult(undefined)
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
    setResult(undefined)
    setBusy("save")
    try {
      const saved = await api<{ version: VersionInfo; valid: boolean; issues: Issue[] }>(
        "POST",
        `/servers/${encodeURIComponent(props.serverId)}/versions`,
        { yaml: text },
      )
      setIssues(saved.issues)
      setSelected(saved.version.id)
      setSavedText(text)
      setResult(
        saved.valid
          ? { tone: "success", text: `Saved version ${saved.version.number}. It can be published.` }
          : {
              tone: "warning",
              text: `Saved version ${saved.version.number} as a draft with problems.`,
            },
      )
      await load()
      bump()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(undefined)
    }
  }

  const publish = async () => {
    if (!selected) return
    setError(undefined)
    setResult(undefined)
    setBusy("publish")
    try {
      const done = await api<{ published: { number: number } }>(
        "POST",
        `/servers/${encodeURIComponent(props.serverId)}/versions/${encodeURIComponent(selected)}/publish`,
      )
      setResult({ tone: "success", text: `Version ${done.published.number} is published.` })
      notify(`Version ${done.published.number} is published.`)
      await load()
      bump()
    } catch (caught) {
      if (caught instanceof ApiError) setIssues(caught.issues)
      setError(caught)
    } finally {
      setBusy(undefined)
    }
  }

  const breadcrumb = (
    <a href="#/" className="text-fg-subtle hover:text-fg">
      Servers
    </a>
  )
  if (!server) {
    return (
      <>
        <PageHeader eyebrow={breadcrumb} title={error ? "Server" : "Loading…"} />
        {error ? (
          <ErrorText error={error} />
        ) : (
          <div className="space-y-4" aria-busy="true">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-96 w-full" />
          </div>
        )}
      </>
    )
  }

  const tabs: { value: Tab; label: string; count?: number }[] = [
    { value: "editor", label: "Editor" },
    { value: "versions", label: "Versions", count: versions.length },
    ...(isAdmin
      ? [
          { value: "secrets" as const, label: "Secrets" },
          { value: "keys" as const, label: "API keys" },
        ]
      : []),
    { value: "logs", label: "Calls" },
  ]
  const reload = () => void load().catch((caught: unknown) => setError(caught))
  const exportUrl = selected
    ? `/api/servers/${encodeURIComponent(server.id)}/versions/${encodeURIComponent(selected)}/export`
    : undefined
  const endpoint = `${window.location.origin}/s/${server.id}/mcp`
  const selectedVersion = versions.find((version) => version.id === selected)
  const live = selected !== undefined && selected === server.publishedVersionId
  // The editor differs from the version it shows: saving makes a new version; publishing
  // publishes the saved one, not these edits.
  const dirty = savedText !== undefined && text !== savedText

  return (
    <>
      <PageHeader
        eyebrow={breadcrumb}
        title={server.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <code className="font-mono text-xs text-fg-subtle">{server.slug}</code>
            <StatusBadges server={server} />
          </span>
        }
      />
      <div className="space-y-5">
        <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface py-1.5 pr-1.5 pl-3">
          <span className="shrink-0 text-xs font-medium text-fg-muted">MCP endpoint</span>
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={endpoint}>
            {endpoint}
          </code>
          <CopyButton value={endpoint} variant="ghost" size="sm" copiedMessage="Endpoint copied" />
        </div>
        <NextSteps serverId={server.id} isAdmin={isAdmin} refresh={refresh} />

        <Tabs
          aria-label="Server"
          value={tab}
          onValueChange={(value) => {
            setTab(value as Tab)
            bump()
          }}
          items={tabs}
        >
          <TabPanel value="editor" keepMounted>
            <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem] 2xl:grid-cols-[minmax(0,1fr)_26rem]">
              <div className="min-w-0 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    aria-label="Version"
                    className="w-40"
                    value={selected ?? ""}
                    onValueChange={(value) => void open(value)}
                    placeholder="(unsaved)"
                    options={versions.map((version) => ({
                      value: version.id,
                      label: `v${version.number}${version.id === server.publishedVersionId ? " (published)" : ""}`,
                    }))}
                  />
                  <Button
                    onClick={() => void save()}
                    loading={busy === "save"}
                    disabled={busy === "publish"}
                    icon={<Save className="size-4" aria-hidden="true" />}
                  >
                    Save as new version
                  </Button>
                  {live ? (
                    <span title="Clients use this version">
                      <Badge tone="success" dot>
                        live
                      </Badge>
                    </span>
                  ) : (
                    <Button
                      variant="primary"
                      onClick={() => void publish()}
                      disabled={!selected || busy === "save"}
                      loading={busy === "publish"}
                      icon={<Upload className="size-4" aria-hidden="true" />}
                    >
                      {selectedVersion ? `Publish v${selectedVersion.number}` : "Publish"}
                    </Button>
                  )}
                  {exportUrl ? (
                    <a
                      href={exportUrl}
                      className={buttonClass("ghost", "icon")}
                      aria-label="Export kervan.yaml"
                      title="Export kervan.yaml"
                    >
                      <Download className="size-4" aria-hidden="true" />
                    </a>
                  ) : null}
                  {dirty ? (
                    <Badge tone="warning" dot>
                      unsaved changes
                    </Badge>
                  ) : null}
                </div>
                {result ? <Alert tone={result.tone}>{result.text}</Alert> : null}
                <ErrorText error={error} />
                <div className="overflow-hidden rounded-lg border border-border bg-surface">
                  <Suspense fallback={<EditorLoading />}>
                    <SpecEditor value={text} onChange={setText} issues={issues} />
                  </Suspense>
                </div>
                <IssueList issues={issues} />
              </div>
              <Playground
                serverId={server.id}
                versionId={selected}
                versionNumber={selectedVersion?.number}
              />
            </div>
          </TabPanel>
          <TabPanel value="versions">
            <VersionsPanel
              server={server}
              versions={versions}
              onOpen={(versionId) => {
                setTab("editor")
                void open(versionId)
              }}
              onChanged={() => {
                reload()
                bump()
              }}
            />
          </TabPanel>
          {isAdmin ? (
            <>
              <TabPanel value="secrets">
                <SecretsPanel serverId={server.id} />
              </TabPanel>
              <TabPanel value="keys">
                <KeysPanel
                  serverId={server.id}
                  serverSlug={server.slug}
                  onCommandCopied={() => {
                    rememberCommandCopied(server.id)
                    bump()
                  }}
                />
              </TabPanel>
            </>
          ) : null}
          <TabPanel value="logs">
            <LogsPanel server={server} isAdmin={isAdmin} onChanged={reload} />
          </TabPanel>
        </Tabs>
      </div>
    </>
  )
}
