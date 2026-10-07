import { Download, KeyRound, Plus, RefreshCw } from "lucide-react"
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
  shortTime,
} from "../components/untrusted.js"
import { Ago, DateOnly } from "../time.js"
import { Badge } from "../ui/Badge.js"
import { Button, buttonClass } from "../ui/Button.js"
import { Card, CardContent, CardHeader } from "../ui/Card.js"
import { CodeBlock, CopyButton } from "../ui/Copy.js"
import { Dialog } from "../ui/Dialog.js"
import { Checkbox, Field, Input } from "../ui/Field.js"
import { Alert } from "../ui/Layout.js"
import { Select } from "../ui/Radix.js"
import { EmptyRow, Table, TBody, TD, TH, THead, TR } from "../ui/Table.js"
import { useToast } from "../ui/Toast.js"

const path = (serverId: string, rest = "") => `/servers/${encodeURIComponent(serverId)}${rest}`

/** Version history: compare two versions, publish one, roll back, export. */
export function VersionsPanel(props: {
  server: Server
  versions: readonly VersionInfo[]
  onOpen: (versionId: string) => void
  onChanged: () => void
}) {
  const notify = useToast()
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [diff, setDiff] = useState<{ lines: DiffLine[] | null }>()
  const [confirm, setConfirm] = useState<VersionInfo>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const published = props.versions.find((v) => v.id === props.server.publishedVersionId)
  const isRollback = (version: VersionInfo) =>
    published !== undefined && version.number < published.number

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
    setBusy(true)
    try {
      await api("POST", path(props.server.id, `/versions/${version.id}/publish`))
      notify(`Version ${version.number} is now published.`)
      props.onChanged()
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
      setConfirm(undefined)
    }
  }

  const options = props.versions.map((v) => ({ value: v.id, label: `v${v.number}` }))
  return (
    <div className="space-y-6">
      <ErrorText error={error} />
      <Card>
        <CardHeader
          title="Versions"
          description="Every save is a new version that never changes. Publish one, or roll back to an older one; connected clients get the new tool list right away."
        />
        <Table aria-label="Versions" className="rounded-none border-0">
          <THead>
            <tr>
              <TH>Version</TH>
              <TH className="hidden sm:table-cell">Saved</TH>
              <TH className="w-px">
                <span className="visually-hidden">Actions</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {props.versions.length === 0 ? (
              <EmptyRow colSpan={3}>No versions yet. Save one from the editor.</EmptyRow>
            ) : null}
            {props.versions.map((version) => {
              const isPublished = version.id === props.server.publishedVersionId
              return (
                <TR key={version.id}>
                  <TD>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="mr-1 font-medium">{`v${version.number}`}</span>
                      {isPublished ? (
                        <Badge tone="success" dot>
                          published
                        </Badge>
                      ) : null}
                      <CheckBadge check={version.check} />
                    </span>
                    <span className="mt-1 block text-xs text-fg-subtle sm:hidden">
                      {shortTime(version.createdAt)}
                    </span>
                  </TD>
                  <TD className="hidden whitespace-nowrap text-fg-muted sm:table-cell">
                    {shortTime(version.createdAt)}
                  </TD>
                  <TD>
                    <div className="flex justify-end gap-1.5">
                      <Button size="sm" variant="ghost" onClick={() => props.onOpen(version.id)}>
                        Open
                      </Button>
                      {isPublished ? null : (
                        <Button size="sm" onClick={() => setConfirm(version)}>
                          {isRollback(version) ? `Roll back to v${version.number}` : "Publish"}
                        </Button>
                      )}
                      <a
                        href={`/api${path(props.server.id, `/versions/${version.id}/export`)}`}
                        className={buttonClass("ghost", "sm")}
                        aria-label={`Export v${version.number}`}
                        title={`Export v${version.number} as kervan.yaml`}
                      >
                        <Download className="size-3.5" aria-hidden="true" />
                        <span className="hidden sm:inline">Export</span>
                      </a>
                    </div>
                  </TD>
                </TR>
              )
            })}
          </TBody>
        </Table>
      </Card>

      <Card>
        <CardHeader title="Compare" description="The lines that changed between two versions." />
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="From" className="w-32">
              <Select value={from} onValueChange={setFrom} options={options} placeholder="from…" />
            </Field>
            <Field label="To" className="w-32">
              <Select value={to} onValueChange={setTo} options={options} placeholder="to…" />
            </Field>
            <Button onClick={() => void compare()} disabled={!from || !to}>
              Compare
            </Button>
          </div>
          {diff ? <DiffView lines={diff.lines} /> : null}
        </CardContent>
      </Card>

      <Dialog
        open={confirm !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirm(undefined)
        }}
        title={
          confirm
            ? isRollback(confirm)
              ? `Roll back to v${confirm.number}?`
              : `Publish v${confirm.number}?`
            : ""
        }
        description="Clients connected to this server switch to this version's tools right away."
        footer={
          <>
            <Button onClick={() => setConfirm(undefined)}>Cancel</Button>
            <Button
              variant="primary"
              loading={busy}
              onClick={() => confirm && void publish(confirm)}
            >
              {confirm && isRollback(confirm) ? "Roll back" : "Publish"}
            </Button>
          </>
        }
      />
    </div>
  )
}

/** Secrets (admins): write-only values, host bindings, and a warning before deleting one in use. */
export function SecretsPanel(props: { serverId: string }) {
  const notify = useToast()
  const [secrets, setSecrets] = useState<SecretSummary[]>()
  // The dialog: a new secret (name "") or an existing one.
  const [editing, setEditing] = useState<{ existing: boolean }>()
  const [name, setName] = useState("")
  const [value, setValue] = useState("")
  const [hosts, setHosts] = useState("")
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<unknown>()
  const [deleting, setDeleting] = useState<{ name: string; inUse?: string }>()
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

  const openEditor = (secret?: SecretSummary) => {
    setName(secret?.name ?? "")
    setHosts(secret?.allowedHosts.join(", ") ?? "")
    setValue("")
    setFormError(undefined)
    setEditing({ existing: secret !== undefined })
  }

  const save = async (event: FormEvent) => {
    event.preventDefault()
    setFormError(undefined)
    setSaving(true)
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
      setEditing(undefined)
      notify(`Saved ${name}.`)
      await load()
    } catch (caught) {
      setFormError(caught)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (secret: string, confirm: boolean) => {
    setError(undefined)
    try {
      await api("DELETE", path(props.serverId, `/secrets/${encodeURIComponent(secret)}`), {
        confirm,
      })
      setDeleting(undefined)
      notify(`Deleted ${secret}.`)
      await load()
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        setDeleting({ name: secret, inUse: caught.message })
      } else {
        setDeleting(undefined)
        setError(caught)
      }
    }
  }

  return (
    <Card>
      <CardHeader
        title="Secrets"
        description="Values are encrypted and can never be read back. Each secret is sent only to its allowed hosts."
        actions={
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="size-4" aria-hidden="true" />}
            onClick={() => openEditor()}
          >
            Add secret
          </Button>
        }
        className="flex-wrap"
      />
      <CardContent className="space-y-4">
        <ErrorText error={error} />
        <SecretTable
          secrets={secrets ?? []}
          onEdit={(secret) => openEditor(secrets?.find((s) => s.name === secret))}
          onDelete={(secret) => setDeleting({ name: secret })}
        />
      </CardContent>

      <Dialog
        open={editing !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setEditing(undefined)
            setValue("")
          }
        }}
        title={editing?.existing ? `Edit ${name}` : "Add secret"}
        description="Use it in the spec as {{secrets.NAME}}."
        footer={
          <>
            <Button onClick={() => setEditing(undefined)}>Cancel</Button>
            <Button type="submit" form="secret-form" variant="primary" loading={saving}>
              Save secret
            </Button>
          </>
        }
      >
        <form id="secret-form" className="space-y-4" onSubmit={save}>
          <Field label="Secret name">
            <Input
              placeholder="API_KEY"
              value={name}
              onChange={(e) => setName(e.target.value)}
              readOnly={editing?.existing ?? false}
              spellCheck={false}
              autoComplete="off"
              className="font-mono"
              required
            />
          </Field>
          <Field
            label="Secret value"
            help={
              editing?.existing
                ? "Leave empty to keep the current value."
                : "Write-only: it is never shown again."
            }
          >
            <Input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              autoComplete="new-password"
              required={!editing?.existing}
            />
          </Field>
          <Field
            label="Allowed hosts"
            help="Comma separated: host or host:port (port 443 when omitted)."
          >
            <Input
              placeholder="api.example.com, api.example.com:8443"
              value={hosts}
              onChange={(e) => setHosts(e.target.value)}
              spellCheck={false}
              required
            />
          </Field>
          <ErrorText error={formError} />
        </form>
      </Dialog>

      <Dialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined)
        }}
        tone="danger"
        title={`Delete ${deleting?.name ?? ""}?`}
        description="Tools that use it fail until you add it again."
        footer={
          <>
            <Button onClick={() => setDeleting(undefined)}>Keep it</Button>
            <Button
              variant="danger"
              onClick={() => deleting && void remove(deleting.name, deleting.inUse !== undefined)}
            >
              {deleting?.inUse ? `Delete ${deleting.name} anyway` : "Delete"}
            </Button>
          </>
        }
      >
        {deleting?.inUse ? <Alert tone="warning">{deleting.inUse}</Alert> : null}
      </Dialog>
    </Card>
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
  const notify = useToast()
  const [keys, setKeys] = useState<KeyInfo[]>()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState("")
  const [created, setCreated] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<unknown>()
  const [revoking, setRevoking] = useState<KeyInfo>()
  const [error, setError] = useState<unknown>()
  const endpoint = `${window.location.origin}/s/${encodeURIComponent(props.serverId)}/mcp`
  const command = (key: string) =>
    `claude mcp add --transport http ${props.serverSlug ?? "studio"} ${endpoint} --header "Authorization: Bearer ${key}"`

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
    setFormError(undefined)
    setBusy(true)
    try {
      const data = await api<{ key: string }>("POST", path(props.serverId, "/keys"), { name })
      setCreated(data.key)
      setName("")
      await load()
    } catch (caught) {
      setFormError(caught)
    } finally {
      setBusy(false)
    }
  }

  const closeCreate = () => {
    // The key leaves the page when the dialog closes.
    setCreating(false)
    setCreated(undefined)
    setName("")
    setFormError(undefined)
  }

  const revoke = async (key: KeyInfo) => {
    setError(undefined)
    setRevoking(undefined)
    try {
      await api("DELETE", path(props.serverId, `/keys/${encodeURIComponent(key.id)}`))
      notify(`Revoked ${key.name}. Clients using it are disconnected.`)
      await load()
    } catch (caught) {
      setError(caught)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader
          title="API keys"
          description="Clients send a key as a bearer token. A key works only for this server; it is shown once, when it is created."
          actions={
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="size-4" aria-hidden="true" />}
              onClick={() => setCreating(true)}
            >
              Create key
            </Button>
          }
          className="flex-wrap"
        />
        <CardContent className="space-y-4">
          <CodeBlock label="MCP endpoint" copy>
            {endpoint}
          </CodeBlock>
          <ErrorText error={error} />
          <Table aria-label="API keys">
            <THead>
              <tr>
                <TH>Name</TH>
                <TH className="hidden sm:table-cell">Key</TH>
                <TH className="hidden md:table-cell">Created</TH>
                <TH className="hidden sm:table-cell">Last used</TH>
                <TH className="w-px">
                  <span className="visually-hidden">Actions</span>
                </TH>
              </tr>
            </THead>
            <TBody>
              {keys?.length === 0 ? (
                <EmptyRow colSpan={5}>No keys yet. Create one to connect a client.</EmptyRow>
              ) : null}
              {(keys ?? []).map((key) => (
                <TR key={key.id} muted={key.revokedAt !== null}>
                  <TD>
                    <span className="font-medium whitespace-nowrap">{key.name}</span>
                    <span className="mt-0.5 block text-xs text-fg-subtle sm:hidden">
                      <code className="font-mono">{`${key.prefix}…`}</code>
                      {" · used "}
                      <Ago time={key.lastUsedAt} />
                    </span>
                  </TD>
                  <TD className="hidden sm:table-cell">
                    <code className="font-mono text-xs">{`${key.prefix}…`}</code>
                  </TD>
                  <TD className="hidden whitespace-nowrap text-fg-muted md:table-cell">
                    <DateOnly time={key.createdAt} />
                  </TD>
                  <TD className="hidden whitespace-nowrap text-fg-muted sm:table-cell">
                    <Ago time={key.lastUsedAt} />
                  </TD>
                  <TD className="text-right">
                    {key.revokedAt ? (
                      <Badge>revoked</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-danger hover:bg-danger-subtle hover:text-danger"
                        onClick={() => setRevoking(key)}
                      >
                        Revoke
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog
        open={creating}
        onOpenChange={(open) => {
          if (!open) closeCreate()
        }}
        size={created ? "lg" : "md"}
        title={created ? "Copy your new key" : "Create API key"}
        description={
          created
            ? "Copy it now. Studio stores only a hash of it and cannot show it again."
            : "Name the key after the client or person that will use it, so you know which one to revoke."
        }
        footer={
          created ? (
            <Button variant="primary" onClick={closeCreate}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={closeCreate}>Cancel</Button>
              <Button
                type="submit"
                form="key-form"
                variant="primary"
                loading={busy}
                icon={<KeyRound className="size-4" aria-hidden="true" />}
              >
                Create key
              </Button>
            </>
          )
        }
      >
        {created ? (
          <div className="space-y-5">
            <div className="flex items-end gap-2">
              <Field label="New API key" className="min-w-0 flex-1">
                <Input
                  readOnly
                  value={created}
                  className="font-mono text-xs"
                  onFocus={(e) => e.target.select()}
                />
              </Field>
              <CopyButton value={created} label="Copy key" copiedMessage="Key copied" />
            </div>
            <CodeBlock
              label="Connect command for Claude Code"
              action={
                <CopyButton
                  value={command(created)}
                  label="Copy command"
                  size="sm"
                  variant="ghost"
                  copiedMessage="Command copied"
                  onCopied={() => props.onCommandCopied?.()}
                />
              }
            >
              {command(created)}
            </CodeBlock>
          </div>
        ) : (
          <form id="key-form" className="space-y-4" onSubmit={create}>
            <Field label="Key name">
              <Input
                placeholder="e.g. claude-code"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={100}
                required
              />
            </Field>
            <ErrorText error={formError} />
          </form>
        )}
      </Dialog>

      <Dialog
        open={revoking !== undefined}
        onOpenChange={(open) => {
          if (!open) setRevoking(undefined)
        }}
        tone="danger"
        title={`Revoke ${revoking?.name ?? ""}?`}
        description="Clients using this key are disconnected at once and cannot connect with it again. This cannot be undone."
        footer={
          <>
            <Button onClick={() => setRevoking(undefined)}>Cancel</Button>
            <Button variant="danger" onClick={() => revoking && void revoke(revoking)}>
              Revoke key
            </Button>
          </>
        }
      />
    </div>
  )
}

/** Recent calls; admins can opt in to logging (redacted, cut) arguments and results. */
export function LogsPanel(props: { server: Server; isAdmin: boolean; onChanged: () => void }) {
  const [calls, setCalls] = useState<CallLogEntry[]>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>()

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await api<{ calls: CallLogEntry[] }>("GET", path(props.server.id, "/logs"))
      setCalls(data.calls)
    } catch (caught) {
      setError(caught)
    } finally {
      setLoading(false)
    }
  }, [props.server.id])
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
    <Card>
      <CardHeader
        title="Calls"
        description="The latest tool calls from clients and the playground."
        actions={
          <Button
            size="sm"
            onClick={() => void load()}
            loading={loading}
            icon={<RefreshCw className="size-3.5" aria-hidden="true" />}
          >
            Refresh
          </Button>
        }
      />
      <CardContent className="space-y-4">
        {props.isAdmin ? (
          <Checkbox
            checked={props.server.logPayloads}
            onChange={() => void toggle()}
            label="Also log arguments and results"
            description="Secret values are redacted and each entry is cut to 4 KiB. Only admins see them."
          />
        ) : null}
        <ErrorText error={error} />
        <CallLogTable calls={calls ?? []} />
      </CardContent>
    </Card>
  )
}

/** A version's latest validation: valid, has problems, or not checked yet. */
export function CheckBadge(props: { check: VersionCheck | null | undefined }) {
  if (!props.check) return <Badge>not checked</Badge>
  if (props.check.valid) {
    return (
      <Badge tone="success" dot>
        valid
      </Badge>
    )
  }
  return (
    <Badge tone="danger" dot>
      {`${props.check.problems} problem${props.check.problems === 1 ? "" : "s"}`}
    </Badge>
  )
}
