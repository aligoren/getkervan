import { type FormEvent, useCallback, useEffect, useState } from "react"
import { api, type User } from "../api.js"
import { ErrorText } from "../components/untrusted.js"

/** A time, or "—" when there is none. */
export function when(time: number | null | undefined): string {
  return typeof time === "number" ? new Date(time).toLocaleString() : "—"
}

/**
 * Changes the signed-in user's password. The current password is required; the new one needs
 * at least 12 characters. Every other session ends.
 */
function PasswordForm(props: { onDone: (sessionsEnded: number) => void }) {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [repeat, setRepeat] = useState("")
  const [error, setError] = useState<unknown>()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    if (next !== repeat) {
      setError(new Error("The new passwords do not match."))
      return
    }
    try {
      const result = await api<{ sessionsEnded: number }>("PUT", "/profile/password", {
        currentPassword: current,
        newPassword: next,
      })
      setCurrent("")
      setNext("")
      setRepeat("")
      props.onDone(result.sessionsEnded)
    } catch (caught) {
      setError(caught)
    }
  }

  return (
    <form className="stack" onSubmit={submit}>
      <label>
        Current password
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <label>
        New password (at least 12 characters)
        <input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          minLength={12}
          required
        />
      </label>
      <label>
        Repeat the new password
        <input
          type="password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          autoComplete="new-password"
          minLength={12}
          required
        />
      </label>
      <ErrorText error={error} />
      <button type="submit">Change password</button>
    </form>
  )
}

/** After an admin reset the password: the only thing the user can do is choose a new one. */
export function ChangePassword(props: { user: User; onDone: () => void; onSignOut: () => void }) {
  return (
    <section className="card">
      <h1>Choose a new password</h1>
      <p className="muted">
        An admin reset the password of {props.user.email}. Choose your own before you continue.
      </p>
      <PasswordForm onDone={props.onDone} />
      <button type="button" onClick={props.onSignOut}>
        Sign out
      </button>
    </section>
  )
}

interface SessionSummary {
  ref: string
  current: boolean
  createdAt: number
  lastSeenAt: number
  ip: string | null
  userAgent: string | null
}

/** The signed-in user's own account: name, password and sessions. */
export function Profile(props: { onChanged: (user: User) => void }) {
  const [user, setUser] = useState<User>()
  const [displayName, setDisplayName] = useState("")
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<unknown>()

  const load = useCallback(async () => {
    try {
      const [profile, listed] = await Promise.all([
        api<{ user: User }>("GET", "/profile"),
        api<{ sessions: SessionSummary[] }>("GET", "/profile/sessions"),
      ])
      setUser(profile.user)
      setDisplayName(profile.user.displayName ?? "")
      setSessions(listed.sessions)
    } catch (caught) {
      setError(caught)
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const act = async (action: () => Promise<string>) => {
    setError(undefined)
    setNotice(undefined)
    try {
      setNotice(await action())
      await load()
    } catch (caught) {
      setError(caught)
    }
  }

  const saveName = (event: FormEvent) => {
    event.preventDefault()
    void act(async () => {
      const saved = await api<{ user: User }>("PUT", "/profile", {
        displayName: displayName.trim() === "" ? null : displayName,
      })
      props.onChanged(saved.user)
      return "Saved."
    })
  }

  if (!user) return <ErrorText error={error} />
  return (
    <section className="profile">
      <h1>Profile</h1>
      {notice ? <p className="notice">{notice}</p> : null}
      <ErrorText error={error} />

      <h2>Account</h2>
      <dl className="facts">
        <dt>Email</dt>
        <dd>{user.email}</dd>
        <dt>Role</dt>
        <dd>{user.role}</dd>
        <dt>Member since</dt>
        <dd>{when(user.createdAt)}</dd>
      </dl>
      <p className="muted">Only an admin can change your email or role.</p>
      <form className="stack" onSubmit={saveName}>
        <label>
          Display name (optional)
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={100}
            autoComplete="name"
          />
        </label>
        <button type="submit">Save name</button>
      </form>

      <h2>Password</h2>
      <PasswordForm
        onDone={(ended) =>
          void act(async () => `Password changed. ${ended} other session(s) were signed out.`)
        }
      />

      <h2>Sessions</h2>
      <table className="sessions">
        <thead>
          <tr>
            <th>Started</th>
            <th>Last active</th>
            <th>IP</th>
            <th>Browser</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sessions.map((session) => (
            <tr key={session.ref}>
              <td>{when(session.createdAt)}</td>
              <td>{when(session.lastSeenAt)}</td>
              <td>{session.ip ?? "—"}</td>
              <td className="wrap">{session.userAgent ?? "—"}</td>
              <td>
                {session.current ? (
                  "this session"
                ) : (
                  <button
                    type="button"
                    onClick={() =>
                      void act(async () => {
                        await api("DELETE", `/profile/sessions/${encodeURIComponent(session.ref)}`)
                        return "Signed out that session."
                      })
                    }
                  >
                    Sign out
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button
        type="button"
        disabled={sessions.every((session) => session.current)}
        onClick={() =>
          void act(async () => {
            const result = await api<{ sessionsEnded: number }>(
              "POST",
              "/profile/sessions/end-others",
            )
            return `Signed out ${result.sessionsEnded} other session(s).`
          })
        }
      >
        Sign out all other sessions
      </button>
    </section>
  )
}
