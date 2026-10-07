import { Check, Circle } from "lucide-react"
import { useEffect, useState } from "react"
import { api, type ServerSummary } from "../api.js"
import { Card } from "../ui/Card.js"
import { cn } from "../ui/cn.js"

interface Overview {
  summary: ServerSummary | null
  /** Whether any saved version is valid (an older one counts too). */
  anyValid?: boolean
  /** How many secrets the published version uses (`null`: nothing published). */
  publishedSecrets?: number | null
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
    // Any valid version counts: a broken newer draft does not undo this step.
    {
      label: "Save a version of the spec that is valid",
      done: valid || overview.anyValid === true,
    },
    { label: "Publish it", done: (overview.summary?.publishedNumber ?? null) !== null },
  ]
  if (props.isAdmin) {
    steps.push(
      {
        label: "Add the secrets the spec uses (Secrets tab), if it uses any",
        done:
          (overview.secrets ?? 0) > 0 ||
          (valid && latest?.check?.secrets === 0) ||
          overview.publishedSecrets === 0,
      },
      { label: "Create an API key (API keys tab)", done: (overview.activeKeys ?? 0) > 0 },
      {
        label: "Copy the connect command and connect a client",
        done: copied.has(props.serverId) || overview.keyUsed === true,
      },
    )
  }
  if (steps.every((step) => step.done)) return null
  const done = steps.filter((step) => step.done).length
  return (
    <Card className="px-5 py-4">
      <section aria-label="Next steps">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="text-sm font-semibold text-fg">Next steps</h2>
          <span className="text-xs text-fg-subtle">{`${done} of ${steps.length} done`}</span>
        </div>
        <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-300"
            style={{ width: `${(done / steps.length) * 100}%` }}
          />
        </div>
        <ol className="mt-3 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          {steps.map((step) => (
            <li
              key={step.label}
              data-done={step.done || undefined}
              className={cn(
                "flex items-start gap-2 text-sm",
                step.done ? "text-fg-subtle line-through decoration-fg-subtle/50" : "text-fg",
              )}
            >
              {step.done ? (
                <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
              ) : (
                <Circle className="mt-0.5 size-4 shrink-0 text-fg-subtle" aria-hidden="true" />
              )}
              <span>
                {step.label}
                {step.done ? <span className="visually-hidden"> (done)</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </section>
    </Card>
  )
}
