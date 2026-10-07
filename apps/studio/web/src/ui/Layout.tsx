import type { ReactNode } from "react"
import { cn } from "./cn.js"

/** A page's title row: title and one-line description, primary actions on the right. */
export function PageHeader(props: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  /** Above the title, e.g. a breadcrumb. */
  eyebrow?: ReactNode
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {props.eyebrow ? <div className="mb-1 text-sm text-fg-subtle">{props.eyebrow}</div> : null}
        <h1 className="truncate text-xl font-semibold tracking-tight text-fg">{props.title}</h1>
        {props.description ? (
          <p className="mt-1 max-w-3xl text-sm text-fg-muted">{props.description}</p>
        ) : null}
      </div>
      {props.actions ? (
        <div className="flex flex-wrap items-center gap-2">{props.actions}</div>
      ) : null}
    </header>
  )
}

/** What an empty list shows: an icon, a sentence, and the action that fills it. */
export function EmptyState(props: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-lg border border-dashed border-border-strong px-6 py-12 text-center",
        props.className,
      )}
    >
      {props.icon ? (
        <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-subtle text-fg-muted">
          {props.icon}
        </div>
      ) : null}
      <h3 className="text-sm font-semibold text-fg">{props.title}</h3>
      {props.description ? (
        <p className="mt-1 max-w-sm text-sm text-fg-muted">{props.description}</p>
      ) : null}
      {props.action ? <div className="mt-4">{props.action}</div> : null}
    </div>
  )
}

/** A message in the page: an error, a warning, or a note. */
export function Alert(props: {
  tone?: "danger" | "warning" | "success" | "neutral"
  title?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const tone = props.tone ?? "neutral"
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      className={cn(
        "rounded-lg border px-4 py-3 text-sm",
        tone === "danger" && "border-danger/30 bg-danger-subtle text-danger",
        tone === "warning" && "border-warning/30 bg-warning-subtle text-warning",
        tone === "success" && "border-success/30 bg-success-subtle text-success",
        tone === "neutral" && "border-border bg-subtle text-fg-muted",
        props.className,
      )}
    >
      {props.title ? <p className="font-medium">{props.title}</p> : null}
      {props.children ? (
        <div className={props.title ? "mt-1" : undefined}>{props.children}</div>
      ) : null}
    </div>
  )
}

/** A placeholder block while something loads. */
export function Skeleton(props: { className?: string }) {
  return (
    <div className={cn("animate-pulse rounded-md bg-muted", props.className)} aria-hidden="true" />
  )
}
