import { useEffect, useState } from "react"
import { api, onSessionEnded, setCsrfToken, type User } from "./api.js"
import { ErrorText } from "./components/untrusted.js"
import { Audit, Users } from "./pages/Admin.js"
import { Login, Setup } from "./pages/Auth.js"
import { ChangePassword, Profile } from "./pages/Profile.js"
import { ServerPage } from "./pages/ServerPage.js"
import { Servers } from "./pages/Servers.js"

type Phase =
  | { kind: "loading" }
  | { kind: "setup" }
  | { kind: "login" }
  | { kind: "ready"; user: User }

function useHash(): string {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const update = () => setHash(window.location.hash)
    window.addEventListener("hashchange", update)
    return () => window.removeEventListener("hashchange", update)
  }, [])
  return hash
}

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const [error, setError] = useState<unknown>()
  const [ended, setEnded] = useState(false)
  const hash = useHash()

  useEffect(() => {
    onSessionEnded(() => {
      setCsrfToken(undefined)
      setEnded(true)
      setPhase({ kind: "login" })
    })
    return () => onSessionEnded(undefined)
  }, [])

  useEffect(() => {
    // Not signed in is an ordinary answer here (200), so the console stays quiet.
    api<{ user: User | null; csrfToken?: string; setupNeeded?: boolean }>("GET", "/session").then(
      (session) => {
        if (!session.user) return setPhase({ kind: session.setupNeeded ? "setup" : "login" })
        setCsrfToken(session.csrfToken)
        setPhase({ kind: "ready", user: session.user })
      },
      (caught: unknown) => setError(caught),
    )
  }, [])

  const logout = async () => {
    await api("POST", "/logout").catch(() => {})
    setCsrfToken(undefined)
    setPhase({ kind: "login" })
  }

  if (error) return <ErrorText error={error} />
  if (phase.kind === "loading") return <p className="muted">Loading…</p>
  const ready = (user: User) => {
    setEnded(false)
    // The console prints /setup; once it is done, the address should not suggest otherwise.
    if (window.location.pathname !== "/") {
      window.history.replaceState(null, "", `/${window.location.hash}`)
    }
    setPhase({ kind: "ready", user })
  }
  if (phase.kind === "setup") return <Setup onDone={ready} />
  if (phase.kind === "login") {
    return (
      <>
        {ended ? <p className="notice">Your session ended. Sign in again.</p> : null}
        <Login onDone={ready} />
      </>
    )
  }
  // An admin reset the password: nothing else until a new one is chosen (the API enforces it too).
  if (phase.user.mustChangePassword) {
    return (
      <ChangePassword
        user={phase.user}
        onDone={() => ready({ ...phase.user, mustChangePassword: false })}
        onSignOut={logout}
      />
    )
  }

  const serverId = /^#\/servers\/([^/]+)$/.exec(hash)?.[1]
  const isAdmin = phase.user.role === "admin"
  const page = serverId ? (
    <ServerPage serverId={decodeURIComponent(serverId)} user={phase.user} />
  ) : hash === "#/users" && isAdmin ? (
    <Users currentUserId={phase.user.id} currentUserEmail={phase.user.email} />
  ) : hash === "#/audit" && isAdmin ? (
    <Audit />
  ) : hash === "#/profile" ? (
    <Profile onChanged={(user) => ready({ ...phase.user, ...user })} />
  ) : (
    <Servers />
  )
  return (
    <div className="app">
      <nav>
        <a href="#/" className="brand">
          Kervan Studio
        </a>
        {/* Every signed-in user works on servers (members edit and publish specs). */}
        <a href="#/">Servers</a>
        {isAdmin ? (
          <>
            <a href="#/users">Users</a>
            <a href="#/audit">Audit log</a>
          </>
        ) : null}
        <a href="#/profile" className="muted">
          {phase.user.displayName || phase.user.email} ({phase.user.role})
        </a>
        <button type="button" onClick={logout}>
          Sign out
        </button>
      </nav>
      <main>{page}</main>
    </div>
  )
}
