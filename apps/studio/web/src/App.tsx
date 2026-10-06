import { useEffect, useState } from "react"
import { ApiError, api, setCsrfToken, type User } from "./api.js"
import { ErrorText } from "./components/untrusted.js"
import { Login, Setup } from "./pages/Auth.js"
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
  const hash = useHash()

  useEffect(() => {
    api<{ user: User; csrfToken: string }>("GET", "/me").then(
      (me) => {
        setCsrfToken(me.csrfToken)
        setPhase({ kind: "ready", user: me.user })
      },
      async (caught: unknown) => {
        if (!(caught instanceof ApiError) || caught.status !== 401) return setError(caught)
        const setup = await api<{ needed: boolean }>("GET", "/setup")
        setPhase({ kind: setup.needed ? "setup" : "login" })
      },
    )
  }, [])

  const logout = async () => {
    await api("POST", "/logout").catch(() => {})
    setCsrfToken(undefined)
    setPhase({ kind: "login" })
  }

  if (error) return <ErrorText error={error} />
  if (phase.kind === "loading") return <p className="muted">Loading…</p>
  const ready = (user: User) => setPhase({ kind: "ready", user })
  if (phase.kind === "setup") return <Setup onDone={ready} />
  if (phase.kind === "login") return <Login onDone={ready} />

  const serverId = /^#\/servers\/([^/]+)$/.exec(hash)?.[1]
  return (
    <div className="app">
      <nav>
        <a href="#/" className="brand">
          Kervan Studio
        </a>
        <span className="muted">
          {phase.user.email} ({phase.user.role})
        </span>
        <button type="button" onClick={logout}>
          Sign out
        </button>
      </nav>
      <main>{serverId ? <ServerPage serverId={decodeURIComponent(serverId)} /> : <Servers />}</main>
    </div>
  )
}
