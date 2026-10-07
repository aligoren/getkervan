import { Loader2 } from "lucide-react"
import type { ButtonHTMLAttributes, ReactNode } from "react"
import { cn } from "./cn.js"

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger"
export type ButtonSize = "sm" | "md" | "icon"

const variants: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-fg shadow-xs hover:bg-accent-hover",
  secondary: "border border-border-strong bg-control text-fg shadow-xs hover:bg-control-hover",
  ghost: "text-fg-muted hover:bg-subtle hover:text-fg",
  danger: "bg-danger text-danger-fg shadow-xs hover:bg-danger-hover",
}

const sizes: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-2.5 text-xs",
  md: "h-9 gap-2 px-3.5 text-sm",
  icon: "size-8",
}

/** Classes for anything that should look like a button (also links). */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md") {
  return cn(
    "inline-flex shrink-0 cursor-pointer items-center justify-center rounded-md font-medium whitespace-nowrap",
    "transition-colors duration-150 ease-out no-underline hover:no-underline",
    "disabled:pointer-events-none disabled:opacity-50",
    variants[variant],
    sizes[size],
  )
}

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  icon,
  className,
  children,
  disabled,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Shows a spinner and blocks clicks while an action runs. */
  loading?: boolean
  icon?: ReactNode
}) {
  return (
    <button
      type={type}
      className={cn(buttonClass(variant, size), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : icon}
      {children}
    </button>
  )
}
