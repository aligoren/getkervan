import type { HTMLAttributes, ReactNode } from "react"
import { cn } from "./cn.js"

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-lg border border-border bg-surface shadow-xs", className)}
      {...rest}
    />
  )
}

/** A card's heading row: title, description, and actions on the right. */
export function CardHeader(props: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 border-b border-border px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-4",
        props.className,
      )}
    >
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-semibold text-fg">{props.title}</h2>
        {props.description ? (
          <p className="mt-0.5 text-sm text-fg-muted">{props.description}</p>
        ) : null}
      </div>
      {props.actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{props.actions}</div>
      ) : null}
    </div>
  )
}

export function CardContent({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-5 py-4", className)} {...rest} />
}

export function CardFooter({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "flex flex-wrap items-center justify-end gap-2 border-t border-border bg-subtle/60 px-5 py-3",
        className,
      )}
      {...rest}
    />
  )
}
