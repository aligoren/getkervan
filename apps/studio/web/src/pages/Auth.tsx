import { type FormEvent, type ReactNode, useState } from "react"
import { api, setCsrfToken, type User } from "../api.js"
import { ErrorText } from "../components/untrusted.js"
import { Button } from "../ui/Button.js"
import { Card } from "../ui/Card.js"
import { Field, Input } from "../ui/Field.js"

interface Session {
  user: User
  csrfToken: string
}

/** The signed-out pages: a centered card under the Studio mark. */
export function AuthLayout(props: {
  title: string
  description?: ReactNode
  notice?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-bg px-4 py-10">
      <div className="mb-6 flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="flex size-9 items-center justify-center rounded-lg bg-accent text-base font-bold text-accent-fg"
        >
          K
        </span>
        <span className="text-base font-semibold tracking-tight">Kervan Studio</span>
      </div>
      <Card className="w-full max-w-sm">
        <div className="px-6 pt-6">
          <h1 className="text-lg font-semibold tracking-tight">{props.title}</h1>
          {props.description ? (
            <p className="mt-1 text-sm text-fg-muted">{props.description}</p>
          ) : null}
        </div>
        <div className="space-y-4 px-6 pt-4 pb-6">
          {props.notice}
          {props.children}
        </div>
      </Card>
    </div>
  )
}

/** First run: create the admin with the token Studio printed on its console. */
export function Setup(props: { onDone: (user: User) => void }) {
  const [token, setToken] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    setBusy(true)
    try {
      const session = await api<Session>("POST", "/setup", { token, email, password })
      setCsrfToken(session.csrfToken)
      props.onDone(session.user)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Set up Kervan Studio"
      description="Enter the one-time setup token from Studio's console and create the first admin."
    >
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Setup token" help="Valid for 30 minutes; restarting Studio prints a new one.">
          <Input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono"
            required
          />
        </Field>
        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </Field>
        <Field label="Password" help="At least 12 characters.">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            minLength={12}
            required
          />
        </Field>
        <ErrorText error={error} />
        <Button type="submit" variant="primary" loading={busy} className="w-full">
          Create admin
        </Button>
      </form>
    </AuthLayout>
  )
}

export function Login(props: { onDone: (user: User) => void; notice?: ReactNode }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    setBusy(true)
    try {
      const session = await api<Session>("POST", "/login", { email, password })
      setCsrfToken(session.csrfToken)
      props.onDone(session.user)
    } catch (caught) {
      setError(caught)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthLayout
      title="Sign in"
      description="Sign in to manage your MCP servers."
      notice={props.notice}
    >
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
            required
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <ErrorText error={error} />
        <Button type="submit" variant="primary" loading={busy} className="w-full">
          Sign in
        </Button>
      </form>
    </AuthLayout>
  )
}
