import { type FormEvent, useCallback, useEffect, useState } from "react"
import { api, type User } from "../api.js"
import { type AuditEntry, AuditTable, ErrorText } from "../components/untrusted.js"

/** Users of the workspace (admins only). */
export function Users() {
  const [users, setUsers] = useState<User[]>([])
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [role, setRole] = useState<"member" | "admin">("member")
  const [confirmDeactivate, setConfirmDeactivate] = useState<string>()
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

  const setDisabled = async (user: User, disabled: boolean) => {
    setError(undefined)
    setConfirmDeactivate(undefined)
    try {
      await api("PUT", `/users/${encodeURIComponent(user.id)}`, { disabled })
      await load()
    } catch (caught) {
      setError(caught)
    }
  }

  const add = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    try {
      await api("POST", "/users", { email, password, role })
      setEmail("")
      setPassword("")
      await load()
    } catch (caught) {
      setError(caught)
    }
  }

  return (
    <section>
      <h1>Users</h1>
      <table className="users">
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => {
            const disabled = typeof user.disabledAt === "number"
            return (
              <tr key={user.id} className={disabled ? "revoked" : undefined}>
                <td>{user.email}</td>
                <td>{user.role}</td>
                <td>{disabled ? "deactivated" : "active"}</td>
                <td>
                  {disabled ? (
                    <button type="button" onClick={() => void setDisabled(user, false)}>
                      Reactivate
                    </button>
                  ) : confirmDeactivate === user.id ? (
                    <>
                      <button type="button" onClick={() => void setDisabled(user, true)}>
                        Deactivate now
                      </button>
                      <button type="button" onClick={() => setConfirmDeactivate(undefined)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button type="button" onClick={() => setConfirmDeactivate(user.id)}>
                      Deactivate
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <p className="muted">
        Deactivating signs the user out at once and ends their playground tokens. API keys belong to
        servers and keep working; revoke them separately.
      </p>
      <form className="inline" onSubmit={add}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          autoComplete="off"
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Initial password (12+ characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={12}
          required
        />
        <select value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
          <option value="member">member</option>
          <option value="admin">admin</option>
        </select>
        <button type="submit">Add user</button>
      </form>
      <ErrorText error={error} />
    </section>
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
