import { type FormEvent, useCallback, useEffect, useState } from "react"
import { api, type Server } from "../api.js"
import { ErrorText } from "../components/untrusted.js"
import { when } from "./Profile.js"

/**
 * Where a server stands: published (and which version), and whether a newer draft is valid,
 * has problems, or was never checked.
 */
export function StatusBadges(props: { server: Server }) {
  const summary = props.server.summary
  const latest = summary?.latest
  const published = summary?.publishedNumber ?? null
  const badges: { text: string; tone: "ok" | "bad" | "plain" }[] = []
  if (published !== null) badges.push({ text: `published v${published}`, tone: "ok" })
  else badges.push({ text: "not published", tone: "plain" })
  if (latest && latest.number !== published) {
    const check = latest.check
    badges.push(
      !check
        ? { text: `draft v${latest.number} not checked`, tone: "plain" }
        : check.valid
          ? { text: `draft v${latest.number} valid`, tone: "ok" }
          : { text: `draft v${latest.number} has problems`, tone: "bad" },
    )
  }
  return (
    <>
      {badges.map((badge) => (
        <span key={badge.text} className={`badge ${badge.tone}`}>
          {badge.text}
        </span>
      ))}
    </>
  )
}

export function ServerList(props: { servers: readonly Server[] }) {
  if (props.servers.length === 0) return <p className="muted">No servers yet.</p>
  return (
    <table className="server-list">
      <thead>
        <tr>
          <th>Server</th>
          <th>Status</th>
          <th>Last call</th>
        </tr>
      </thead>
      <tbody>
        {props.servers.map((server) => (
          <tr key={server.id}>
            <td>
              <a href={`#/servers/${encodeURIComponent(server.id)}`}>{server.name}</a>{" "}
              <span className="muted">{server.slug}</span>
            </td>
            <td>
              <StatusBadges server={server} />
            </td>
            <td>{when(server.summary?.lastCallAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
        <label>
          Slug (a-z, 0-9, -)
          <input
            placeholder="weather"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            required
          />
        </label>
        <label>
          Name
          <input
            placeholder="Weather"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </label>
        <button type="submit">Create server</button>
      </form>
      <ErrorText error={error} />
    </section>
  )
}
