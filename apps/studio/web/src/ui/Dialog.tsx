import * as RadixDialog from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "./cn.js"

/**
 * A modal dialog (Radix: focus trap, Escape to close, labelled by its title). Controlled:
 * `open` and `onOpenChange`. Put the form's buttons in `footer`.
 */
export function Dialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** "danger" draws a thin danger accent for destructive confirmations. */
  tone?: "default" | "danger"
  size?: "sm" | "md" | "lg"
}) {
  return (
    <RadixDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px] data-[state=open]:animate-[fade-in_150ms_ease-out]" />
        <RadixDialog.Content
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col",
            "rounded-xl border border-border bg-surface shadow-lg",
            "data-[state=open]:animate-[dialog-in_150ms_ease-out]",
            props.size === "lg" ? "max-w-2xl" : props.size === "sm" ? "max-w-sm" : "max-w-lg",
            props.tone === "danger" && "border-t-2 border-t-danger",
          )}
        >
          <div className="flex items-start justify-between gap-4 px-5 pt-5">
            <div className="min-w-0">
              <RadixDialog.Title className="text-base font-semibold text-fg">
                {props.title}
              </RadixDialog.Title>
              {props.description ? (
                <RadixDialog.Description className="mt-1 text-sm text-fg-muted">
                  {props.description}
                </RadixDialog.Description>
              ) : (
                <RadixDialog.Description className="visually-hidden">
                  {props.title}
                </RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close
              className="-mt-1 -mr-1 rounded-md p-1 text-fg-subtle transition-colors hover:bg-subtle hover:text-fg"
              aria-label="Close"
            >
              <X className="size-4" aria-hidden="true" />
            </RadixDialog.Close>
          </div>
          {props.children ? (
            <div className="overflow-y-auto px-5 py-4 text-sm">{props.children}</div>
          ) : (
            <div className="h-4" />
          )}
          {props.footer ? (
            <div className="flex flex-wrap justify-end gap-2 rounded-b-xl border-t border-border bg-subtle/60 px-5 py-3">
              {props.footer}
            </div>
          ) : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
