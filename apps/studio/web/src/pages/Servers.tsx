import { type FormEvent, useCallback, useEffect, useState } from "react"
import { api, type Server } from "../api.js"
import { ErrorText } from "../components/untrusted.js"

export function ServerList(props: { servers: readonly Server[] }) {
  if (props.servers.length === 0) return <p className="muted">No servers yet.</p>
  return (
    <ul className="servers">
      {props.servers.map((server) => (
        <li key={server.id}>
          <a href={`#/servers/${encodeURIComponent(server.id)}`}>{server.name}</a>{" "}
          <span className="muted">
            {server.slug} · {server.publishedVersionId ? "published" : "not published"}
          </span>
        </li>
      ))}
    </ul>
  )
}

export function Servers() {
  const [servers, setServers] = useState<Server[]>([])
  const [slug, setSlug] = useState("")
  const [name, setName] = useState("")
  const [error, setError] = useState<unknown>()

  const load = useCallback(
    () =>
      api<{ servers: Server[] }>("GET", "/servers").then(
        (data) => setServers(data.servers),
        (caught: unknown) => setError(caught),
      ),
    [],
  )

  useEffect(() => {
    void load()
  }, [load])

  const create = async (event: FormEvent) => {
    event.preventDefault()
    setError(undefined)
    try {
      await api("POST", "/servers", { slug, name })
      setSlug("")
      setName("")
      await load()
    } catch (caught) {
      setError(caught)
    }
  }

  return (
    <section>
      <h1>Servers</h1>
      <ServerList servers={servers} />
      <form className="inline" onSubmit={create}>
        <input
          placeholder="slug (a-z, 0-9, -)"
          value={slug}
          onChange={(e) => setSlug(e.target.value)}
          required
        />
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        <button type="submit">Create server</button>
      </form>
      <ErrorText error={error} />
    </section>
  )
}
