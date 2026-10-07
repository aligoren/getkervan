import {
  cloneElement,
  type InputHTMLAttributes,
  isValidElement,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useId,
} from "react"
import { cn } from "./cn.js"

const control =
  "w-full rounded-md border border-border-input bg-control px-3 text-sm text-fg shadow-xs " +
  "placeholder:text-fg-subtle transition-colors duration-150 " +
  "focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-ring/40 " +
  "disabled:cursor-not-allowed disabled:bg-subtle disabled:text-fg-muted read-only:bg-subtle " +
  "aria-[invalid=true]:border-danger"

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(control, "h-9", className)} {...rest} />
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(control, "min-h-20 py-2 leading-relaxed", className)} {...rest} />
}

/** A native select (accessible, works with the keyboard and on phones), styled. */
export function NativeSelect({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(control, "h-9 cursor-pointer pr-8", className)} {...rest} />
}

/**
 * A form field: a visible label, the control, then help text or an error. Wires `id`,
 * `aria-describedby` and `aria-invalid` onto the control.
 */
export function Field(props: {
  label: ReactNode
  help?: ReactNode
  error?: ReactNode
  /** Shown after the label, e.g. "optional". */
  hint?: ReactNode
  className?: string
  children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>
}) {
  const id = useId()
  const describedBy = props.error ? `${id}-error` : props.help ? `${id}-help` : undefined
  const control = isValidElement(props.children)
    ? cloneElement(props.children, {
        id,
        ...(describedBy ? { "aria-describedby": describedBy } : {}),
        ...(props.error ? { "aria-invalid": true } : {}),
      })
    : props.children
  return (
    <div className={cn("flex flex-col gap-1.5", props.className)}>
      <label htmlFor={id} className="text-sm font-medium text-fg">
        {props.label}
        {props.hint ? (
          <span className="ml-1.5 font-normal text-fg-subtle">{props.hint}</span>
        ) : null}
      </label>
      {control}
      {props.error ? (
        <p id={`${id}-error`} className="text-xs text-danger">
          {props.error}
        </p>
      ) : props.help ? (
        <p id={`${id}-help`} className="text-xs text-fg-subtle">
          {props.help}
        </p>
      ) : null}
    </div>
  )
}

/** A checkbox with its label to the right. */
export function Checkbox(props: {
  label: ReactNode
  checked: boolean
  onChange: (checked: boolean) => void
  description?: ReactNode
}) {
  const id = useId()
  return (
    <div className="flex items-start gap-2.5">
      <input
        id={id}
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
        className="mt-0.5 size-4 cursor-pointer accent-accent"
      />
      <label htmlFor={id} className="cursor-pointer text-sm leading-5">
        {props.label}
        {props.description ? (
          <span className="block text-xs text-fg-subtle">{props.description}</span>
        ) : null}
      </label>
    </div>
  )
}
