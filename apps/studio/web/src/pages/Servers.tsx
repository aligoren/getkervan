import { Plus, Server as ServerIcon } from "lucide-react"
import { type FormEvent, useCallback, useEffect, useState } from "react"
import { api, type Server } from "../api.js"
import { ErrorText } from "../components/untrusted.js"
import { SLUG, slugify } from "../slug.js"
import { Ago } from "../time.js"
import { Badge, type BadgeTone } from "../ui/Badge.js"
import { Button } from "../ui/Button.js"
import { Dialog } from "../ui/Dialog.js"
import { Field, Input } from "../ui/Field.js"
import { EmptyState, PageHeader, Skeleton } from "../ui/Layout.js"
import { EmptyRow, Table, TBody, TD, TH, THead, TR } from "../ui/Table.js"

/**
 * Where a server stands: published (and which version), and whether a newer draft is valid,
 * has problems, or was never checked.
 */
export function StatusBadges(props: { server: Server }) {
  const summary = props.server.summary
  const latest = summary?.latest
  const published = summary?.publishedNumber ?? null
  const badges: { text: string; tone: BadgeTone }[] = []
  if (typeof props.server.disabledAt === "number") badges.push({ text: "disabled", tone: "danger" })
  if (published !== null) badges.push({ text: `published v${published}`, tone: "success" })
  else badges.push({ text: "not published", tone: "neutral" })
  if (latest && latest.number !== published) {
    const check = latest.check
    badges.push(
      !check
        ? { text: `draft v${latest.number} not checked`, tone: "neutral" }
        : check.valid
          ? { text: `draft v${latest.number} valid`, tone: "accent" }
          : { text: `draft v${latest.number} has problems`, tone: "danger" },
    )
  }
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {badges.map((badge) => (
        <Badge key={badge.text} tone={badge.tone} dot>
          {badge.text}
        </Badge>
      ))}
    </span>
  )
}

export function ServerList(props: { servers: readonly Server[] }) {
  return (
    <Table aria-label="Servers">
      <THead>
        <tr>
          <TH>Server</TH>
          <TH>Status</TH>
          <TH className="hidden text-right sm:table-cell">Last call</TH>
        </tr>
      </THead>
      <TBody>
        {props.servers.length === 0 ? <EmptyRow colSpan={3}>No servers yet.</EmptyRow> : null}
        {props.servers.map((server) => (
          <TR key={server.id}>
            <TD className="sm:min-w-48">
              <a
                href={`#/servers/${encodeURIComponent(server.id)}`}
                className="font-medium text-fg hover:text-accent-text"
              >
                {server.name}
              </a>
              <div className="font-mono text-xs text-fg-subtle">{server.slug}</div>
              <div className="mt-1 text-xs text-fg-subtle sm:hidden">
                {"Last call "}
                <Ago time={server.summary?.lastCallAt} />
              </div>
            </TD>
            <TD>
              <StatusBadges server={server} />
            </TD>
            <TD className="hidden text-right whitespace-nowrap text-fg-muted sm:table-cell">
              <Ago time={server.summary?.lastCallAt} />
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  )
}

/**
 * Creates a server. The slug follows the name as it is typed, until the user edits the slug
 * themselves.
 */
export function CreateServerDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (server: Server) => void
}) {
  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugEdited, setSlugEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()

  // A fresh form each time the dialog opens.
  useEffect(() => {
    if (!props.open) return
    setName("")
    setSlug("")
    setSlugEdited(false)
    setError(undefined)
  }, [props.open])

  const slugProblem =
    slug !== "" && !SLUG.test(slug)
      ? "Use a-z, 0-9 and -, starting and ending with a letter or digit (at most 64)."
      : undefined

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    setBusy(true)
    try {
      const created = await api<{ server: Server }>("POST", "/servers", { slug, name })
      props.onCreated(created.server)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="Create server"
      description="A server is a set of tools that MCP clients connect to. You write its spec next."
      footer={
        <>
          <Button onClick={() => props.onOpenChange(false)}>Cancel</Button>
          <Button
            type="submit"
            form="create-server"
            variant="primary"
            loading={busy}
            disabled={name.trim() === "" || slug === "" || slugProblem !== undefined}
          >
            Create server
          </Button>
        </>
      }
    >
      <form id="create-server" className="space-y-4" onSubmit={submit}>
        <Field label="Name">
          <Input
            value={name}
            placeholder="Weather"
            maxLength={200}
            onChange={(e) => {
              setName(e.target.value)
              if (!slugEdited) setSlug(slugify(e.target.value))
            }}
            required
          />
        </Field>
        <Field
          label="Slug"
          help="Lowercase letters, digits and dashes. Filled in from the name until you edit it."
          error={slugProblem}
        >
          <Input
            value={slug}
            placeholder="weather"
            maxLength={64}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
            onChange={(e) => {
              setSlug(e.target.value)
              setSlugEdited(true)
            }}
            required
          />
        </Field>
        <ErrorText error={error} />
      </form>
    </Dialog>
  )
}

export function Servers() {
  const [servers, setServers] = useState<Server[]>()
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<unknown>()

  const load = useCallback(
    () =>
      api<{ servers: Server[] }>("GET", "/servers").then(
        (data) => setServers(data.servers),
        (caught: unknown) => setError(caught),
      ),
    [],
  )

  useEffect(() => {
    void load()
  }, [load])

  const create = (
    <Button
      variant="primary"
      icon={<Plus className="size-4" aria-hidden="true" />}
      onClick={() => setCreating(true)}
    >
      Create server
    </Button>
  )

  return (
    <>
      <PageHeader
        title="Servers"
        description="Each server is a published spec that MCP clients reach at its own endpoint."
        actions={servers && servers.length > 0 ? create : undefined}
      />
      <ErrorText error={error} className="mb-4" />
      {servers === undefined ? (
        error ? null : (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        )
      ) : servers.length === 0 ? (
        <EmptyState
          icon={<ServerIcon className="size-5" aria-hidden="true" />}
          title="No servers yet"
          description="Create a server, write its spec in the editor, try it in the playground, then publish it."
          action={create}
        />
      ) : (
        <ServerList servers={servers} />
      )}
      <CreateServerDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(server) => {
          setCreating(false)
          window.location.hash = `#/servers/${encodeURIComponent(server.id)}`
        }}
      />
    </>
  )
}
