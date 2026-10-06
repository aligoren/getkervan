import { type FormEvent, useState } from "react"
import { api, setCsrfToken, type User } from "../api.js"
import { ErrorText } from "../components/untrusted.js"

interface Session {
  user: User
  csrfToken: string
}

/** First run: create the admin with the token Studio printed on its console. */
export function Setup(props: { onDone: (user: User) => void }) {
  const [token, setToken] = useState("")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<unknown>()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    try {
      const session = await api<Session>("POST", "/setup", { token, email, password })
      setCsrfToken(session.csrfToken)
      props.onDone(session.user)
    } catch (caught) {
      setError(caught)
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>Set up Kervan Studio</h1>
      <p className="muted">
        Enter the one-time setup token from Studio's console and create the first admin.
      </p>
      <label>
        Setup token
        <input
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          required
        />
      </label>
      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
        />
      </label>
      <label>
        Password (at least 12 characters)
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={12}
          required
        />
      </label>
      <ErrorText error={error} />
      <button type="submit">Create admin</button>
    </form>
  )
}

export function Login(props: { onDone: (user: User) => void }) {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<unknown>()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    try {
      const session = await api<Session>("POST", "/login", { email, password })
      setCsrfToken(session.csrfToken)
      props.onDone(session.user)
    } catch (caught) {
      setError(caught)
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h1>Kervan Studio</h1>
      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
        />
      </label>
      <label>
        Password
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <ErrorText error={error} />
      <button type="submit">Sign in</button>
    </form>
  )
}
