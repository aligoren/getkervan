import { type FormEvent, useCallback, useEffect, useState } from "react"
import { api, type User } from "../api.js"
import { UsernameField } from "../components/UsernameField.js"
import { type AuditEntry, AuditTable, ErrorText } from "../components/untrusted.js"
import { when } from "./Profile.js"

interface UserKey {
  id: string
  name: string
  prefix: string
  serverName: string
}

/** What the page is asking about, below the table. */
type Pending =
  | { kind: "deactivate"; user: User; keys: UserKey[] }
  | { kind: "reset"; user: User }
  | { kind: "email"; user: User }
  | { kind: "temporary"; user: User; password: string }
  | { kind: "role"; user: User; role: "admin" | "member" }

/** Users of the workspace (admins only). */
export function Users(props: { currentUserId?: string; currentUserEmail?: string } = {}) {
  const [users, setUsers] = useState<User[]>([])
  const [pending, setPending] = useState<Pending>()
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<unknown>()

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

  /** Runs a change, then reloads; errors (a clash, the last admin) show above the table. */
  const act = async (action: () => Promise<string | undefined>) => {
    setError(undefined)
    setNotice(undefined)
    try {
      setNotice(await action())
      await load()
    } catch (caught) {
      setError(caught)
    }
  }
  const path = (user: User, rest = "") => `/users/${encodeURIComponent(user.id)}${rest}`

  const askToDeactivate = (user: User) =>
    void act(async () => {
      const data = await api<{ keys: UserKey[] }>("GET", path(user, "/keys"))
      setPending({ kind: "deactivate", user, keys: data.keys })
      return undefined
    })

  return (
    <section>
      <h1>Users</h1>
      {notice ? <p className="notice">{notice}</p> : null}
      <ErrorText error={error} />
      <table className="users">
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th>Created</th>
            <th>Last login</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => {
            const disabled = typeof user.disabledAt === "number"
            return (
              <tr key={user.id} className={disabled ? "revoked" : undefined}>
                <td>
                  {user.email}
                  {user.displayName ? <div className="muted">{user.displayName}</div> : null}
                </td>
                <td>
                  <select
                    aria-label={`Role of ${user.email}`}
                    value={user.role}
                    // A role change asks first, with the admin's own password (the API insists too).
                    onChange={(e) =>
                      setPending({
                        kind: "role",
                        user,
                        role: e.target.value === "admin" ? "admin" : "member",
                      })
                    }
                  >
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                  </select>
                </td>
                <td>
                  {disabled ? "deactivated" : "active"}
                  {user.mustChangePassword ? (
                    <div className="muted">must change password</div>
                  ) : null}
                </td>
                <td>{when(user.createdAt)}</td>
                <td>{when(user.lastLoginAt)}</td>
                <td className="actions">
                  <button type="button" onClick={() => setPending({ kind: "email", user })}>
                    Edit email
                  </button>
                  {user.id === props.currentUserId ? null : (
                    <button type="button" onClick={() => setPending({ kind: "reset", user })}>
                      Reset password
                    </button>
                  )}
                  {disabled ? (
                    <button
                      type="button"
                      onClick={() =>
                        void act(async () => {
                          await api("PUT", path(user), { disabled: false })
                          return `${user.email} is active again.`
                        })
                      }
                    >
                      Reactivate
                    </button>
                  ) : (
                    <button type="button" onClick={() => askToDeactivate(user)}>
                      Deactivate
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {pending?.kind === "deactivate" ? (
        <DeactivateBox
          pending={pending}
          onCancel={() => setPending(undefined)}
          onConfirm={(revokeKeys) =>
            void act(async () => {
              setPending(undefined)
              await api("PUT", path(pending.user), {
                disabled: true,
                ...(revokeKeys ? { revokeKeys: true } : {}),
              })
              return `${pending.user.email} is deactivated.`
            })
          }
        />
      ) : null}
      {pending?.kind === "email" ? (
        <EmailBox
          user={pending.user}
          onCancel={() => setPending(undefined)}
          onSave={(email) =>
            act(async () => {
              await api("PUT", path(pending.user, "/email"), { email })
              setPending(undefined)
              return `Email changed to ${email.trim().toLowerCase()}.`
            })
          }
        />
      ) : null}
      {pending?.kind === "role" ? (
        <RoleBox
          user={pending.user}
          role={pending.role}
          adminEmail={props.currentUserEmail ?? ""}
          onCancel={() => setPending(undefined)}
          onConfirm={(adminPassword) =>
            act(async () => {
              await api("PUT", path(pending.user, "/role"), {
                role: pending.role,
                adminPassword,
              })
              setPending(undefined)
              return `${pending.user.email} is now ${pending.role}.`
            })
          }
        />
      ) : null}
      {pending?.kind === "reset" ? (
        <ResetBox
          adminEmail={props.currentUserEmail ?? ""}
          user={pending.user}
          onCancel={() => setPending(undefined)}
          onReset={(adminPassword, password) =>
            act(async () => {
              const result = await api<{ temporaryPassword?: string; sessionsEnded: number }>(
                "POST",
                path(pending.user, "/password-reset"),
                { adminPassword, ...(password ? { password } : {}) },
              )
              setPending(
                result.temporaryPassword
                  ? { kind: "temporary", user: pending.user, password: result.temporaryPassword }
                  : undefined,
              )
              return `Password reset for ${pending.user.email}; ${result.sessionsEnded} session(s) ended. They must choose a new one at their next sign-in.`
            })
          }
        />
      ) : null}
      {pending?.kind === "temporary" ? (
        <div className="callout">
          <p>
            Temporary password for {pending.user.email}. It is shown once: give it to them
            privately.
          </p>
          <input readOnly value={pending.password} aria-label="Temporary password" />
          <button
            type="button"
            onClick={() => void navigator.clipboard?.writeText(pending.password)}
          >
            Copy
          </button>
          <button type="button" onClick={() => setPending(undefined)}>
            Done
          </button>
        </div>
      ) : null}

      <p className="muted">
        Users are deactivated, never deleted, so the audit log keeps pointing at them. Deactivating
        signs the user out at once and ends their playground tokens.
      </p>
      <AddUser onAdded={(email) => void act(async () => `Added ${email}.`)} />
    </section>
  )
}

function DeactivateBox(props: {
  pending: Extract<Pending, { kind: "deactivate" }>
  onCancel: () => void
  onConfirm: (revokeKeys: boolean) => void
}) {
  const { user, keys } = props.pending
  // Checked by default: a deactivated user's keys are usually meant to stop too.
  const [revokeKeys, setRevokeKeys] = useState(true)
  return (
    <div className="callout">
      <p>{`Deactivate ${user.email}? They are signed out at once.`}</p>
      {keys.length > 0 ? (
        <>
          <p>{`API keys ${user.email} created:`}</p>
          <ul>
            {keys.map((key) => (
              <li key={key.id}>{`${key.name} (${key.prefix}…) on ${key.serverName}`}</li>
            ))}
          </ul>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={revokeKeys}
              onChange={(e) => setRevokeKeys(e.target.checked)}
            />
            {`Also revoke these ${keys.length} API key(s)`}
          </label>
        </>
      ) : (
        <p className="muted">They created no API keys that are still active.</p>
      )}
      <button type="button" onClick={() => props.onConfirm(keys.length > 0 && revokeKeys)}>
        Deactivate now
      </button>
      <button type="button" onClick={props.onCancel}>
        Cancel
      </button>
    </div>
  )
}

function EmailBox(props: {
  user: User
  onCancel: () => void
  onSave: (email: string) => Promise<void>
}) {
  const [email, setEmail] = useState(props.user.email)
  return (
    <form
      className="callout stack"
      onSubmit={(event) => {
        event.preventDefault()
        void props.onSave(email)
      }}
    >
      <label>
        {`New email for ${props.user.email}`}
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
          required
        />
      </label>
      <div className="inline">
        <button type="submit">Save email</button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function RoleBox(props: {
  user: User
  role: "admin" | "member"
  adminEmail: string
  onCancel: () => void
  onConfirm: (adminPassword: string) => Promise<void>
}) {
  const [adminPassword, setAdminPassword] = useState("")
  return (
    <form
      className="callout stack"
      onSubmit={(event) => {
        event.preventDefault()
        void props.onConfirm(adminPassword)
      }}
    >
      <p>
        {props.role === "admin"
          ? `Make ${props.user.email} an admin? Admins manage users, secrets and API keys, and read the audit log.`
          : `Make ${props.user.email} a member? They keep editing and publishing specs, but lose access to users, secrets, keys and the audit log.`}
      </p>
      <UsernameField username={props.adminEmail} />
      <label>
        Your password, to confirm
        <input
          type="password"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <div className="inline">
        <button type="submit">{`Make ${props.role}`}</button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function ResetBox(props: {
  user: User
  adminEmail: string
  onCancel: () => void
  onReset: (adminPassword: string, password: string) => Promise<void>
}) {
  const [password, setPassword] = useState("")
  const [adminPassword, setAdminPassword] = useState("")
  return (
    <form
      className="callout stack"
      onSubmit={(event) => {
        event.preventDefault()
        void props.onReset(adminPassword, password)
      }}
    >
      <p>
        {`Reset the password of ${props.user.email}. All their sessions end, and they must choose a new password at their next sign-in.`}
      </p>
      <UsernameField username={props.adminEmail} />
      <label>
        Temporary password (leave empty to generate one)
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={12}
        />
      </label>
      <label>
        Your password, to confirm
        <input
          type="password"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <div className="inline">
        <button type="submit">Reset password</button>
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function AddUser(props: { onAdded: (email: string) => void }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState<"member" | "admin">("member")
  const [error, setError] = useState<unknown>()

  const add = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    try {
      await api("POST", "/users", { email, password, role })
      setEmail("")
      setPassword("")
      props.onAdded(email)
    } catch (caught) {
      setError(caught)
    }
  }

  return (
    <form className="add-user" onSubmit={add}>
      <h2>Add a user</h2>
      <div className="fields">
        <label>
          Email
          <input
            type="email"
            value={email}
            autoComplete="off"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          Initial password (at least 12 characters)
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
          />
        </label>
        <label>
          Role
          <select value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
            <option value="member">member</option>
            <option value="admin">admin</option>
          </select>
        </label>
        <button type="submit">Add user</button>
      </div>
      <ErrorText error={error} />
    </form>
  )
}

/** The audit log (admins only). */
export function Audit() {
  const [events, setEvents] = useState<AuditEntry[]>([])
  const [error, setError] = useState<unknown>()
  useEffect(() => {
    api<{ events: AuditEntry[] }>("GET", "/audit").then(
      (data) => setEvents(data.events),
      (caught: unknown) => setError(caught),
    )
  }, [])
  return (
    <section>
      <h1>Audit log</h1>
      <AuditTable events={events} />
      <ErrorText error={error} />
    </section>
  )
}
