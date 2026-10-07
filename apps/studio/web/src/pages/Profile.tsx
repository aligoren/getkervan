import { Laptop, LogOut } from "lucide-react"
import { type FormEvent, useCallback, useEffect, useState } from "react"
import { api, type User } from "../api.js"
import { UsernameField } from "../components/UsernameField.js"
import { ErrorText } from "../components/untrusted.js"
import { deviceName } from "../device.js"
import { Ago, DateOnly } from "../time.js"
import { Badge } from "../ui/Badge.js"
import { Button } from "../ui/Button.js"
import { Card, CardContent, CardFooter, CardHeader } from "../ui/Card.js"
import { Field, Input } from "../ui/Field.js"
import { PageHeader, Skeleton } from "../ui/Layout.js"
import { useToast } from "../ui/Toast.js"
import { AuthLayout } from "./Auth.js"

/**
 * Changes the signed-in user's password. The current password is required; the new one needs
 * at least 12 characters. Every other session ends.
 */
function PasswordForm(props: {
  username: string
  onDone: (sessionsEnded: number) => void
  /** In a card: fields in the body, the button in the card's footer. */
  inCard?: boolean
}) {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [repeat, setRepeat] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    if (next !== repeat) {
      setError(new Error("The new passwords do not match."))
      return
    }
    setBusy(true)
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
    } finally {
      setBusy(false)
    }
  }

  const fields = (
    <div className="space-y-4">
      <UsernameField username={props.username} />
      <Field label="Current password">
        <Input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          autoComplete="current-password"
          required
        />
      </Field>
      <Field label="New password" help="At least 12 characters.">
        <Input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          autoComplete="new-password"
          minLength={12}
          required
        />
      </Field>
      <Field label="Repeat the new password">
        <Input
          type="password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          autoComplete="new-password"
          minLength={12}
          required
        />
      </Field>
      <ErrorText error={error} />
    </div>
  )

  if (props.inCard) {
    return (
      <form onSubmit={submit}>
        <CardContent className="max-w-md">{fields}</CardContent>
        <CardFooter>
          <Button type="submit" variant="primary" loading={busy}>
            Change password
          </Button>
        </CardFooter>
      </form>
    )
  }
  return (
    <form onSubmit={submit} className="space-y-4">
      {fields}
      <Button type="submit" variant="primary" loading={busy} className="w-full">
        Change password
      </Button>
    </form>
  )
}

/** After an admin reset the password: the only thing the user can do is choose a new one. */
export function ChangePassword(props: { user: User; onDone: () => void; onSignOut: () => void }) {
  return (
    <AuthLayout
      title="Choose a new password"
      description={`An admin reset the password of ${props.user.email}. Choose your own before you continue.`}
    >
      <PasswordForm username={props.user.email} onDone={props.onDone} />
      <Button
        variant="ghost"
        className="w-full"
        onClick={props.onSignOut}
        icon={<LogOut className="size-4" aria-hidden="true" />}
      >
        Sign out
      </Button>
    </AuthLayout>
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
  const notify = useToast()
  const [user, setUser] = useState<User>()
  const [displayName, setDisplayName] = useState("")
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [savingName, setSavingName] = useState(false)
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
    try {
      notify(await action())
      await load()
    } catch (caught) {
      setError(caught)
    }
  }

  const saveName = async (event: FormEvent) => {
    event.preventDefault()
    setSavingName(true)
    await act(async () => {
      const saved = await api<{ user: User }>("PUT", "/profile", {
        displayName: displayName.trim() === "" ? null : displayName,
      })
      props.onChanged(saved.user)
      return "Name saved."
    })
    setSavingName(false)
  }

  const header = (
    <PageHeader
      title="Profile"
      description="Your account, your password and the browsers where you are signed in."
    />
  )
  if (!user) {
    return (
      <div className="max-w-3xl">
        {header}
        {error ? (
          <ErrorText error={error} />
        ) : (
          <div className="space-y-4" aria-busy="true">
            <Skeleton className="h-40 w-full" />
            <Skeleton className="h-72 w-full" />
          </div>
        )}
      </div>
    )
  }
  const others = sessions.filter((session) => !session.current).length
  // Forms read best at a comfortable width, not stretched across a wide screen.
  return (
    <div className="max-w-3xl">
      {header}
      <div className="space-y-6">
        <ErrorText error={error} />

        <Card>
          <CardHeader title="Account" description="Only an admin can change your email or role." />
          <form onSubmit={(e) => void saveName(e)}>
            <CardContent className="space-y-5">
              <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
                <div className="min-w-0">
                  <dt className="text-xs text-fg-subtle">Email</dt>
                  <dd className="mt-0.5 font-medium break-all">{user.email}</dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-subtle">Role</dt>
                  <dd className="mt-0.5">
                    <Badge tone={user.role === "admin" ? "accent" : "neutral"}>{user.role}</Badge>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-fg-subtle">Member since</dt>
                  <dd className="mt-0.5">
                    <DateOnly time={user.createdAt} />
                  </dd>
                </div>
              </dl>
              <Field label="Display name" hint="optional" className="max-w-md">
                <Input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  maxLength={100}
                  autoComplete="name"
                />
              </Field>
            </CardContent>
            <CardFooter>
              <Button type="submit" loading={savingName}>
                Save name
              </Button>
            </CardFooter>
          </form>
        </Card>

        <Card>
          <CardHeader
            title="Password"
            description="Changing it signs you out everywhere else; this session stays."
          />
          <PasswordForm
            inCard
            username={user.email}
            onDone={(ended) =>
              void act(async () => `Password changed. ${ended} other session(s) were signed out.`)
            }
          />
        </Card>

        <Card>
          <CardHeader
            title="Sessions"
            description="Browsers where you are signed in. Sign out any you do not recognize."
            actions={
              <Button
                size="sm"
                disabled={others === 0}
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
              </Button>
            }
            className="flex-wrap"
          />
          <ul className="divide-y divide-border" aria-label="Sessions">
            {sessions.map((session) => (
              <li key={session.ref} className="flex items-center gap-x-4 gap-y-2 px-5 py-3.5">
                <Laptop
                  className="hidden size-5 shrink-0 text-fg-subtle sm:block"
                  aria-hidden="true"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium" title={session.userAgent ?? undefined}>
                      {deviceName(session.userAgent)}
                    </span>
                    {session.current ? (
                      <Badge tone="success" dot>
                        this session
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 text-xs break-words text-fg-subtle">
                    {`${session.ip ?? "unknown address"} · signed in `}
                    <Ago time={session.createdAt} />
                    {" · active "}
                    <Ago time={session.lastSeenAt} />
                  </p>
                </div>
                {session.current ? null : (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void act(async () => {
                        await api("DELETE", `/profile/sessions/${encodeURIComponent(session.ref)}`)
                        return "Signed out that session."
                      })
                    }
                  >
                    Sign out
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  )
}
