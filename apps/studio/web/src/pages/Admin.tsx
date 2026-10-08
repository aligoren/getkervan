import {
  Ellipsis,
  KeyRound,
  Mail,
  RefreshCw,
  ShieldCheck,
  UserCheck,
  UserPlus,
  UserX,
} from "lucide-react"
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react"
import { api, type User } from "../api.js"
import { UsernameField } from "../components/UsernameField.js"
import { type AuditEntry, AuditTable, ErrorText } from "../components/untrusted.js"
import { Ago, DateOnly } from "../time.js"
import { Badge } from "../ui/Badge.js"
import { Button } from "../ui/Button.js"
import { CopyButton } from "../ui/Copy.js"
import { Dialog } from "../ui/Dialog.js"
import { Checkbox, Field, Input } from "../ui/Field.js"
import { Alert, PageHeader, Skeleton } from "../ui/Layout.js"
import { Menu, Select } from "../ui/Radix.js"
import { Table, TBody, TD, TH, THead, TR } from "../ui/Table.js"
import { useToast } from "../ui/Toast.js"

type Role = "admin" | "member"

const ROLE_OPTIONS = [
  { value: "member", label: "member" },
  { value: "admin", label: "admin" },
]

interface UserKey {
  id: string
  name: string
  prefix: string
  serverName: string
}

/** The dialog that is open, if any. */
type Pending =
  | { kind: "deactivate"; user: User; keys: UserKey[] }
  | { kind: "reset"; user: User }
  | { kind: "email"; user: User }
  | { kind: "temporary"; user: User; password: string }
  | { kind: "role"; user: User }
  | { kind: "add" }

const userPath = (user: User, rest = "") => `/users/${encodeURIComponent(user.id)}${rest}`

/**
 * A dialog with a form: runs `onSubmit`, shows its error in the dialog, and keeps the dialog
 * open until it succeeds.
 */
function FormDialog(props: {
  title: string
  description?: ReactNode
  submitLabel: string
  tone?: "default" | "danger"
  onSubmit: () => Promise<void>
  onClose: () => void
  children: ReactNode
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    setBusy(true)
    try {
      await props.onSubmit()
    } catch (caught) {
      setError(caught)
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose()
      }}
      title={props.title}
      description={props.description}
      tone={props.tone ?? "default"}
      footer={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button
            type="submit"
            form="user-dialog"
            variant={props.tone === "danger" ? "danger" : "primary"}
            loading={busy}
          >
            {props.submitLabel}
          </Button>
        </>
      }
    >
      <form id="user-dialog" className="space-y-4" onSubmit={submit}>
        {props.children}
        <ErrorText error={error} />
      </form>
    </Dialog>
  )
}

/** Users of the workspace (admins only). */
export function Users(props: { currentUserId?: string; currentUserEmail?: string } = {}) {
  const notify = useToast()
  const [users, setUsers] = useState<User[]>()
  const [pending, setPending] = useState<Pending>()
  const [error, setError] = useState<unknown>()
  const adminEmail = props.currentUserEmail ?? ""

  const load = useCallback(
    () =>
      api<{ users: User[] }>("GET", "/users").then(
        (data) => setUsers(data.users),
        (caught: unknown) => setError(caught),
      ),
    [],
  )
  useEffect(() => {
    void load()
  }, [load])

  /** After a change: close the dialog, say what happened, reload. */
  const done = async (message: string, next?: Pending) => {
    setPending(next)
    notify(message)
    await load()
  }

  const askToDeactivate = async (user: User) => {
    setError(undefined)
    try {
      const data = await api<{ keys: UserKey[] }>("GET", userPath(user, "/keys"))
      setPending({ kind: "deactivate", user, keys: data.keys })
    } catch (caught) {
      setError(caught)
    }
  }

  const reactivate = async (user: User) => {
    setError(undefined)
    try {
      await api("PUT", userPath(user), { disabled: false })
      await done(`${user.email} is active again.`)
    } catch (caught) {
      setError(caught)
    }
  }

  const close = () => setPending(undefined)

  return (
    <>
      <PageHeader
        title="Users"
        description="Who can sign in to this Studio. Users are deactivated, never deleted, so the audit log keeps pointing at them."
        actions={
          <Button
            variant="primary"
            icon={<UserPlus className="size-4" aria-hidden="true" />}
            onClick={() => setPending({ kind: "add" })}
          >
            Add user
          </Button>
        }
      />
      <ErrorText error={error} className="mb-4" />
      {users === undefined ? (
        error ? null : (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        )
      ) : (
        <Table aria-label="Users">
          <THead>
            <tr>
              <TH>User</TH>
              <TH className="hidden sm:table-cell">Role</TH>
              <TH className="hidden sm:table-cell">Status</TH>
              <TH className="hidden lg:table-cell">Created</TH>
              <TH className="hidden md:table-cell">Last login</TH>
              <TH className="w-px">
                <span className="visually-hidden">Actions</span>
              </TH>
            </tr>
          </THead>
          <TBody>
            {users.map((user) => {
              const disabled = typeof user.disabledAt === "number"
              const self = user.id === props.currentUserId
              return (
                <TR key={user.id} muted={disabled} data-disabled={disabled || undefined}>
                  <TD className="break-all sm:min-w-56">
                    <span className="font-medium">{user.email}</span>
                    {self ? <span className="ml-1.5 text-xs text-fg-subtle">(you)</span> : null}
                    {user.displayName ? (
                      <span className="block text-xs text-fg-subtle">{user.displayName}</span>
                    ) : null}
                    {/* Narrow screens: role, status and last login under the email. */}
                    <span className="mt-1.5 flex flex-wrap items-center gap-1.5 break-normal sm:hidden">
                      <Badge tone={user.role === "admin" ? "accent" : "neutral"}>{user.role}</Badge>
                      {disabled ? <Badge dot>deactivated</Badge> : null}
                      {user.mustChangePassword ? (
                        <Badge tone="warning">must change password</Badge>
                      ) : null}
                      <span className="text-xs text-fg-subtle">
                        {"Last login "}
                        <Ago time={user.lastLoginAt} />
                      </span>
                    </span>
                  </TD>
                  <TD className="hidden sm:table-cell">
                    <Badge tone={user.role === "admin" ? "accent" : "neutral"}>{user.role}</Badge>
                  </TD>
                  <TD className="hidden sm:table-cell">
                    <span className="inline-flex flex-wrap gap-1.5">
                      {disabled ? (
                        <Badge dot>deactivated</Badge>
                      ) : (
                        <Badge tone="success" dot>
                          active
                        </Badge>
                      )}
                      {user.mustChangePassword ? (
                        <Badge tone="warning">must change password</Badge>
                      ) : null}
                    </span>
                  </TD>
                  <TD className="hidden whitespace-nowrap text-fg-muted lg:table-cell">
                    <DateOnly time={user.createdAt} />
                  </TD>
                  <TD className="hidden whitespace-nowrap text-fg-muted md:table-cell">
                    <Ago time={user.lastLoginAt} />
                  </TD>
                  <TD>
                    <Menu
                      label={`Actions for ${user.email}`}
                      trigger={
                        <Button variant="ghost" size="icon">
                          <Ellipsis className="size-4" aria-hidden="true" />
                        </Button>
                      }
                      items={[
                        {
                          label: "Edit email",
                          icon: <Mail />,
                          onSelect: () => setPending({ kind: "email", user }),
                        },
                        {
                          label: "Change role",
                          icon: <ShieldCheck />,
                          onSelect: () => setPending({ kind: "role", user }),
                        },
                        ...(self
                          ? []
                          : [
                              {
                                label: "Reset password",
                                icon: <KeyRound />,
                                onSelect: () => setPending({ kind: "reset", user }),
                              },
                            ]),
                        "separator" as const,
                        disabled
                          ? {
                              label: "Reactivate",
                              icon: <UserCheck />,
                              onSelect: () => void reactivate(user),
                            }
                          : {
                              label: "Deactivate",
                              icon: <UserX />,
                              danger: true,
                              onSelect: () => void askToDeactivate(user),
                            },
                      ]}
                    />
                  </TD>
                </TR>
              )
            })}
          </TBody>
        </Table>
      )}

      {pending?.kind === "add" ? (
        <AddUserDialog
          adminEmail={adminEmail}
          onClose={close}
          onAdded={(email) => done(`Added ${email}.`)}
        />
      ) : null}
      {pending?.kind === "deactivate" ? (
        <DeactivateDialog
          pending={pending}
          onClose={close}
          onConfirm={async (revokeKeys) => {
            await api("PUT", userPath(pending.user), {
              disabled: true,
              ...(revokeKeys ? { revokeKeys: true } : {}),
            })
            await done(`${pending.user.email} is deactivated.`)
          }}
        />
      ) : null}
      {pending?.kind === "email" ? (
        <EmailDialog
          user={pending.user}
          onClose={close}
          onSave={async (email) => {
            await api("PUT", userPath(pending.user, "/email"), { email })
            await done(`Email changed to ${email.trim().toLowerCase()}.`)
          }}
        />
      ) : null}
      {pending?.kind === "role" ? (
        <RoleDialog
          user={pending.user}
          self={pending.user.id === props.currentUserId}
          adminEmail={adminEmail}
          onClose={close}
          onConfirm={async (role, adminPassword) => {
            await api("PUT", userPath(pending.user, "/role"), { role, adminPassword })
            await done(`${pending.user.email} is now ${role}.`)
          }}
        />
      ) : null}
      {pending?.kind === "reset" ? (
        <ResetDialog
          adminEmail={adminEmail}
          user={pending.user}
          onClose={close}
          onReset={async (adminPassword, password) => {
            const result = await api<{ temporaryPassword?: string; sessionsEnded: number }>(
              "POST",
              userPath(pending.user, "/password-reset"),
              { adminPassword, ...(password ? { password } : {}) },
            )
            await done(
              `Password reset for ${pending.user.email}; ${result.sessionsEnded} session(s) ended.`,
              result.temporaryPassword
                ? { kind: "temporary", user: pending.user, password: result.temporaryPassword }
                : undefined,
            )
          }}
        />
      ) : null}
      {pending?.kind === "temporary" ? (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) close()
          }}
          title="Password reset"
          description={`The temporary password for ${pending.user.email} is shown once: give it to them privately. They must choose their own at their next sign-in.`}
          footer={
            <Button variant="primary" onClick={close}>
              Done
            </Button>
          }
        >
          <div className="flex items-end gap-2">
            <Field label="Temporary password" className="min-w-0 flex-1">
              <Input
                readOnly
                value={pending.password}
                className="font-mono"
                onFocus={(e) => e.target.select()}
              />
            </Field>
            <CopyButton value={pending.password} label="Copy" copiedMessage="Password copied" />
          </div>
        </Dialog>
      ) : null}
    </>
  )
}

function DeactivateDialog(props: {
  pending: Extract<Pending, { kind: "deactivate" }>
  onClose: () => void
  onConfirm: (revokeKeys: boolean) => Promise<void>
}) {
  const { user, keys } = props.pending
  // Checked by default: a deactivated user's keys are usually meant to stop too.
  const [revokeKeys, setRevokeKeys] = useState(true)
  return (
    <FormDialog
      tone="danger"
      title={`Deactivate ${user.email}?`}
      description="They are signed out at once and their playground tokens stop working. You can reactivate them later."
      submitLabel="Deactivate"
      onClose={props.onClose}
      onSubmit={() => props.onConfirm(keys.length > 0 && revokeKeys)}
    >
      {keys.length > 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-fg">{`API keys ${user.email} created:`}</p>
          <ul className="space-y-1 rounded-md border border-border bg-subtle px-3 py-2 text-sm">
            {keys.map((key) => (
              <li key={key.id}>
                <span className="font-medium">{key.name}</span>{" "}
                <code className="font-mono text-xs text-fg-subtle">{`${key.prefix}…`}</code>{" "}
                <span className="text-fg-muted">{`on ${key.serverName}`}</span>
              </li>
            ))}
          </ul>
          <Checkbox
            checked={revokeKeys}
            onChange={setRevokeKeys}
            label={`Also revoke these ${keys.length} API key(s)`}
            description="Clients using them are disconnected. Leave it unchecked to keep them working."
          />
        </div>
      ) : (
        <p className="text-sm text-fg-muted">They created no API keys that are still active.</p>
      )}
    </FormDialog>
  )
}

function EmailDialog(props: {
  user: User
  onClose: () => void
  onSave: (email: string) => Promise<void>
}) {
  const [email, setEmail] = useState(props.user.email)
  return (
    <FormDialog
      title="Edit email"
      description={`The address ${props.user.email} signs in with.`}
      submitLabel="Save email"
      onClose={props.onClose}
      onSubmit={() => props.onSave(email)}
    >
      <Field label="New email">
        <Input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
          required
        />
      </Field>
    </FormDialog>
  )
}

function RoleDialog(props: {
  user: User
  /** The signed-in admin's own account: changing it signs them out. */
  self?: boolean
  adminEmail: string
  onClose: () => void
  onConfirm: (role: Role, adminPassword: string) => Promise<void>
}) {
  const [role, setRole] = useState<Role>(props.user.role === "admin" ? "member" : "admin")
  const [adminPassword, setAdminPassword] = useState("")
  const unchanged = role === props.user.role
  return (
    <FormDialog
      title={`Change the role of ${props.user.email}`}
      description={
        props.self
          ? "You will be signed out everywhere, and sign in again with the new role."
          : "They are signed out everywhere, and sign in again with the new role."
      }
      submitLabel={`Make ${role}`}
      onClose={props.onClose}
      onSubmit={async () => {
        if (unchanged) throw new Error(`${props.user.email} is already ${role}.`)
        await props.onConfirm(role, adminPassword)
      }}
    >
      <Field label="Role">
        <Select
          value={role}
          onValueChange={(value) => setRole(value === "admin" ? "admin" : "member")}
          options={ROLE_OPTIONS}
          className="w-40"
        />
      </Field>
      <Alert tone={unchanged ? "neutral" : "warning"}>
        {unchanged
          ? `${props.user.email} is already ${role}.`
          : role === "admin"
            ? `Make ${props.user.email} an admin? Admins manage users, secrets and API keys, and read the audit log.`
            : `Make ${props.user.email} a member? They keep editing and publishing specs, but lose access to users, secrets, keys and the audit log.`}
      </Alert>
      <UsernameField username={props.adminEmail} />
      <Field label="Your password, to confirm">
        <Input
          type="password"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </Field>
    </FormDialog>
  )
}

function ResetDialog(props: {
  user: User
  adminEmail: string
  onClose: () => void
  onReset: (adminPassword: string, password: string) => Promise<void>
}) {
  const [password, setPassword] = useState("")
  const [adminPassword, setAdminPassword] = useState("")
  return (
    <FormDialog
      tone="danger"
      title={`Reset the password of ${props.user.email}?`}
      description="All their sessions end, and they must choose a new password at their next sign-in."
      submitLabel="Reset password"
      onClose={props.onClose}
      onSubmit={() => props.onReset(adminPassword, password)}
    >
      <UsernameField username={props.adminEmail} />
      <Field
        label="New temporary password"
        hint="optional"
        help="Leave empty to generate one. At least 12 characters."
      >
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={12}
        />
      </Field>
      <Field label="Your password, to confirm">
        <Input
          type="password"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </Field>
    </FormDialog>
  )
}

function AddUserDialog(props: {
  adminEmail: string
  onClose: () => void
  onAdded: (email: string) => Promise<void>
}) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState<Role>("member")
  const [adminPassword, setAdminPassword] = useState("")
  return (
    <FormDialog
      title="Add user"
      description="Give them the initial password privately; they can change it on their profile."
      submitLabel="Add user"
      onClose={props.onClose}
      onSubmit={async () => {
        await api("POST", "/users", { email, password, role, adminPassword })
        await props.onAdded(email)
      }}
    >
      <Field label="Email">
        <Input
          type="email"
          value={email}
          autoComplete="off"
          onChange={(e) => setEmail(e.target.value)}
          required
        />
      </Field>
      <Field label="Initial password" help="At least 12 characters.">
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={12}
          required
        />
      </Field>
      <Field
        label="Role"
        help="Members edit, publish and try specs. Admins also manage users, secrets, keys and the audit log."
      >
        <Select
          value={role}
          onValueChange={(value) => setRole(value === "admin" ? "admin" : "member")}
          options={ROLE_OPTIONS}
          className="w-40"
        />
      </Field>
      <UsernameField username={props.adminEmail} />
      <Field label="Your password, to confirm">
        <Input
          type="password"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </Field>
    </FormDialog>
  )
}

/** The audit log (admins only), with users' emails and servers' names for their ids. */
export function Audit() {
  const [events, setEvents] = useState<AuditEntry[]>()
  const [names, setNames] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>()
  const load = useCallback(async () => {
    setLoading(true)
    setError(undefined)
    try {
      const [data, users, servers] = await Promise.all([
        api<{ events: AuditEntry[] }>("GET", "/audit"),
        api<{ users: User[] }>("GET", "/users"),
        api<{ servers: { id: string; name: string }[] }>("GET", "/servers"),
      ])
      setNames(
        new Map([
          ...users.users.map((user) => [user.id, user.email] as const),
          ...servers.servers.map((server) => [server.id, server.name] as const),
        ]),
      )
      setEvents(data.events)
    } catch (caught) {
      setError(caught)
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Who did what: sign-ins and sign-outs, users and profiles, servers, secrets and API keys. The latest 100 entries, newest first; entries cannot be edited or deleted, and passwords, secret values and keys are never recorded."
        actions={
          <Button
            onClick={() => void load()}
            loading={loading}
            icon={<RefreshCw className="size-4" aria-hidden="true" />}
          >
            Refresh
          </Button>
        }
      />
      <ErrorText error={error} className="mb-4" />
      {events === undefined ? (
        error ? null : (
          <div className="space-y-2" aria-busy="true">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        )
      ) : (
        <AuditTable events={events} names={names} />
      )}
    </>
  )
}
