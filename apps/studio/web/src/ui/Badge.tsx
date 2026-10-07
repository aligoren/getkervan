import type { ReactNode } from "react"
import { cn } from "./cn.js"

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger"

const tones: Record<BadgeTone, string> = {
  neutral: "border-border bg-subtle text-fg-muted",
  accent: "border-transparent bg-accent-subtle text-accent-text",
  success: "border-transparent bg-success-subtle text-success",
  warning: "border-transparent bg-warning-subtle text-warning",
  danger: "border-transparent bg-danger-subtle text-danger",
}

const dots: Record<BadgeTone, string> = {
  neutral: "bg-fg-subtle",
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
}

/** A short status label. `dot` adds a colored dot (the color is never the only signal). */
export function Badge(props: {
  tone?: BadgeTone
  dot?: boolean
  children: ReactNode
  className?: string
}) {
  const tone = props.tone ?? "neutral"
  return (
    <span
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap",
        tones[tone],
        props.className,
      )}
    >
      {props.dot ? (
        <span className={cn("size-1.5 rounded-full", dots[tone])} aria-hidden="true" />
      ) : null}
      {props.children}
    </span>
  )
}
