import { useEffect, useState } from "react"
import { api, type ServerSummary } from "../api.js"

interface Overview {
  summary: ServerSummary | null
  /** Admins only. */
  secrets?: number
  activeKeys?: number
  /** Whether a client has used one of the server's keys. */
  keyUsed?: boolean
}

// Kept in page memory only (the web UI uses no browser storage): a reload forgets it, and then a
// key that a client has used ticks the step off instead.
const copied = new Set<string>()

/** Remembers that the connect command of a server was copied. */
export function rememberCommandCopied(serverId: string): void {
  copied.add(serverId)
}

/**
 * The steps a new server still needs, ticked off as they are done: a valid version, published,
 * its secrets, an API key, and the connect command. Hidden once everything is done.
 * `refresh` changes whenever something that affects the steps may have changed.
 */
export function NextSteps(props: { serverId: string; isAdmin: boolean; refresh: number }) {
  const [overview, setOverview] = useState<Overview>()

  // biome-ignore lint/correctness/useExhaustiveDependencies: `refresh` asks for a reload
  useEffect(() => {
    api<Overview>("GET", `/servers/${encodeURIComponent(props.serverId)}/overview`).then(
      setOverview,
      () => setOverview(undefined),
    )
  }, [props.serverId, props.refresh])

  if (!overview) return null
  const latest = overview.summary?.latest
  const valid = latest?.check?.valid === true
  const steps: { label: string; done: boolean }[] = [
    { label: "Save a version of the spec that is valid", done: valid },
    { label: "Publish it", done: (overview.summary?.publishedNumber ?? null) !== null },
  ]
  if (props.isAdmin) {
    steps.push(
      {
        label: "Add the secrets the spec uses (Secrets tab), if it uses any",
        done: (overview.secrets ?? 0) > 0 || (valid && latest?.check?.secrets === 0),
      },
      { label: "Create an API key (API keys tab)", done: (overview.activeKeys ?? 0) > 0 },
      {
        label: "Copy the connect command and connect a client",
        done: copied.has(props.serverId) || overview.keyUsed === true,
      },
    )
  }
  if (steps.every((step) => step.done)) return null
  return (
    <section className="next-steps" aria-label="Next steps">
      <h2>Next steps</h2>
      <ol>
        {steps.map((step) => (
          <li key={step.label} className={step.done ? "done" : undefined}>
            <span aria-hidden="true">{step.done ? "✓" : "○"}</span> {step.label}
            {step.done ? <span className="visually-hidden"> (done)</span> : null}
          </li>
        ))}
      </ol>
    </section>
  )
}
