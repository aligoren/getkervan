import { Check, Copy } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { Button, type ButtonSize, type ButtonVariant } from "./Button.js"
import { cn } from "./cn.js"
import { useToast } from "./Toast.js"

/** Copies `value` to the clipboard, says so in a toast, and shows a check for a moment. */
export function CopyButton(props: {
  value: string
  label?: string
  /** Toast text; default "Copied to the clipboard". */
  copiedMessage?: string
  variant?: ButtonVariant
  size?: ButtonSize
  onCopied?: () => void
  className?: string
}) {
  const notify = useToast()
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      notify(props.copiedMessage ?? "Copied to the clipboard")
      props.onCopied?.()
    } catch {
      notify("Could not copy. Select the text and copy it yourself.", "danger")
    }
  }
  const icon = copied ? (
    <Check className="size-4 text-success" aria-hidden="true" />
  ) : (
    <Copy className="size-4" aria-hidden="true" />
  )
  return (
    <Button
      variant={props.variant ?? "secondary"}
      size={props.size ?? (props.label ? "md" : "icon")}
      onClick={() => void copy()}
      icon={icon}
      className={props.className}
      aria-label={props.label ? undefined : "Copy"}
    >
      {props.label}
    </Button>
  )
}

/**
 * Monospaced text in a box: commands, keys, JSON. Long lines wrap (or scroll with
 * `wrap={false}`), so nothing runs out of its container. With a `label`, the box is a figure
 * named by its caption.
 */
export function CodeBlock(props: {
  children: string
  copy?: boolean
  wrap?: boolean
  label?: string
  /** Shown at the right of the label, e.g. a copy button with its own label. */
  action?: ReactNode
  className?: string
}) {
  const id = useId()
  const copy = props.copy ? <CopyButton value={props.children} variant="ghost" size="icon" /> : null
  const pre = (
    <pre
      className={cn(
        "max-h-96 overflow-auto px-3 py-2.5 font-mono text-[0.8125rem] leading-relaxed text-fg",
        // Wrap at spaces; break inside a word only when a word is longer than the line.
        props.wrap === false ? "whitespace-pre" : "whitespace-pre-wrap [overflow-wrap:anywhere]",
        copy && !props.label && "pr-12",
      )}
    >
      {props.children}
    </pre>
  )
  const box = cn("relative m-0 rounded-lg border border-border bg-subtle", props.className)
  if (!props.label) {
    return (
      <div className={box}>
        {pre}
        {copy ? <div className="absolute top-1.5 right-1.5">{copy}</div> : null}
      </div>
    )
  }
  return (
    <figure aria-labelledby={id} className={box}>
      <figcaption className="flex min-h-9 items-center justify-between gap-2 border-b border-border py-0.5 pr-1 pl-3">
        <span id={id} className="text-xs font-medium text-fg-muted">
          {props.label}
        </span>
        {props.action ?? copy}
      </figcaption>
      {pre}
    </figure>
  )
}
