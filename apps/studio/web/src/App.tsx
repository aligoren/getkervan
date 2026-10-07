import { Loader2 } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { api, onSessionEnded, setCsrfToken, type User } from "./api.js"
import { ErrorText } from "./components/untrusted.js"
import { Audit, Users } from "./pages/Admin.js"
import { Login, Setup } from "./pages/Auth.js"
import { ChangePassword, Profile } from "./pages/Profile.js"
import { ServerPage } from "./pages/ServerPage.js"
import { Servers } from "./pages/Servers.js"
import { Settings } from "./pages/Settings.js"
import { AppShell, type Section } from "./shell/AppShell.js"
import { applyTheme, type ThemeChoice } from "./theme.js"
import { Alert } from "./ui/Layout.js"
import { ToastProvider, useToast } from "./ui/Toast.js"

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
  return (
    <ToastProvider>
      <Studio />
    </ToastProvider>
  )
}

function Studio() {
  const notify = useToast()
  const [phase, setPhase] = useState<Phase>({ kind: "loading" })
  const [error, setError] = useState<unknown>()
  const [ended, setEnded] = useState(false)
  const hash = useHash()

  // Signed out, the page follows the system theme; signed in, the user's choice.
  const signedOut = useCallback((kind: "login" | "setup") => {
    setCsrfToken(undefined)
    applyTheme("system")
    setPhase({ kind })
  }, [])

  useEffect(() => {
    onSessionEnded(() => {
      setEnded(true)
      signedOut("login")
    })
    return () => onSessionEnded(undefined)
  }, [signedOut])

  useEffect(() => {
    // Not signed in is an ordinary answer here (200), so the console stays quiet.
    api<{ user: User | null; csrfToken?: string; setupNeeded?: boolean }>("GET", "/session").then(
      (session) => {
        if (!session.user) return signedOut(session.setupNeeded ? "setup" : "login")
        setCsrfToken(session.csrfToken)
        applyTheme(session.user.theme ?? "system")
        setPhase({ kind: "ready", user: session.user })
      },
      (caught: unknown) => setError(caught),
    )
  }, [signedOut])

  const logout = async () => {
    await api("POST", "/logout").catch(() => {})
    signedOut("login")
  }

  if (error) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg px-4">
        <div className="w-full max-w-md">
          <Alert tone="danger" title="Kervan Studio could not start">
            <ErrorText error={error} />
          </Alert>
        </div>
      </div>
    )
  }
  if (phase.kind === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg" aria-busy="true">
        <Loader2 className="size-6 animate-spin text-fg-subtle" aria-hidden="true" />
        <span className="visually-hidden">Loading…</span>
      </div>
    )
  }
  const ready = (user: User) => {
    setEnded(false)
    // The console prints /setup; once it is done, the address should not suggest otherwise.
    if (window.location.pathname !== "/") {
      window.history.replaceState(null, "", `/${window.location.hash}`)
    }
    applyTheme(user.theme ?? "system")
    setPhase({ kind: "ready", user })
  }
  if (phase.kind === "setup") return <Setup onDone={ready} />
  if (phase.kind === "login") {
    return (
      <Login
        onDone={ready}
        notice={
          ended ? <Alert tone="warning">Your session ended. Sign in again.</Alert> : undefined
        }
      />
    )
  }
  const user = phase.user
  // An admin reset the password: nothing else until a new one is chosen (the API enforces it too).
  if (user.mustChangePassword) {
    return (
      <ChangePassword
        user={user}
        onDone={() => ready({ ...user, mustChangePassword: false })}
        onSignOut={logout}
      />
    )
  }

  const theme: ThemeChoice = user.theme ?? "system"
  const setTheme = async (choice: ThemeChoice) => {
    // Show it at once; the server keeps it so it follows the user to other devices.
    applyTheme(choice)
    setPhase({ kind: "ready", user: { ...user, theme: choice } })
    try {
      await api("PUT", "/profile/theme", { theme: choice })
    } catch {
      applyTheme(theme)
      setPhase({ kind: "ready", user: { ...user, theme } })
      notify("Could not save the theme. Try again.", "danger")
    }
  }

  // Server ids are UUIDs: nothing to decode, and any other text (a malformed escape, "..") is no
  // server link, so it shows the list instead of breaking the page.
  const serverId = /^#\/servers\/([A-Za-z0-9-]{1,64})$/.exec(hash)?.[1]
  const isAdmin = user.role === "admin"
  let section: Section = "servers"
  let page = <Servers />
  if (serverId) {
    page = <ServerPage serverId={serverId} user={user} />
  } else if (hash === "#/users" && isAdmin) {
    section = "users"
    page = <Users currentUserId={user.id} currentUserEmail={user.email} />
  } else if (hash === "#/audit" && isAdmin) {
    section = "audit"
    page = <Audit />
  } else if (hash === "#/settings") {
    section = "settings"
    page = <Settings user={user} theme={theme} onTheme={(choice) => void setTheme(choice)} />
  } else if (hash === "#/profile") {
    section = "profile"
    page = <Profile onChanged={(changed) => ready({ ...user, ...changed })} />
  }
  return (
    <AppShell
      user={user}
      section={section}
      theme={theme}
      onTheme={(choice) => void setTheme(choice)}
      onSignOut={() => void logout()}
      wide={serverId !== undefined}
    >
      {page}
    </AppShell>
  )
}
