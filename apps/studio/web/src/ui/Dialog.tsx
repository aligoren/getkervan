import * as RadixDialog from "@radix-ui/react-dialog"
import { X } from "lucide-react"
import { type ReactNode, useLayoutEffect, useRef } from "react"
import { cn } from "./cn.js"

/**
 * What had focus when a dialog opened: the button that opened it. A dialog opened from a "…" menu
 * item gets the menu's button instead, since the item is gone once the menu closes.
 */
function opener(): HTMLElement | null {
  const active = document.activeElement
  if (!(active instanceof HTMLElement) || active === document.body) return null
  const menu = active.closest('[role="menu"]')
  if (menu?.id) {
    return document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`)
  }
  return active
}

/**
 * A modal dialog (Radix: focus trap, Escape to close, labelled by its title). Controlled:
 * `open` and `onOpenChange`. Put the form's buttons in `footer`. Closing gives focus back to what
 * opened it, so keyboard users continue where they were.
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
  const returnTo = useRef<HTMLElement | null>(null)
  // Layout effects run before Radix moves focus into the dialog, so this still sees the opener.
  // Closing (or unmounting) gives focus back after Radix is done.
  useLayoutEffect(() => {
    if (!props.open) return
    returnTo.current = opener()
    return () => {
      const target = returnTo.current
      setTimeout(() => {
        if (target?.isConnected) target.focus()
      }, 0)
    }
  }, [props.open])

  return (
    <RadixDialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[1px] data-[state=open]:animate-[fade-in_150ms_ease-out]" />
        <RadixDialog.Content
          // Focus goes back to the opener (above), not wherever Radix would put it.
          onCloseAutoFocus={(event) => event.preventDefault()}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col",
            "rounded-xl border border-border bg-surface shadow-lg",
            // Opening focuses the first field, or the first footer button (Cancel), not the close
            // button: it comes last in the DOM and sits in the corner.
            "data-[state=open]:animate-[dialog-in_150ms_ease-out]",
            props.size === "lg" ? "max-w-2xl" : props.size === "sm" ? "max-w-sm" : "max-w-lg",
            props.tone === "danger" && "border-t-2 border-t-danger",
          )}
        >
          <div className="px-5 pt-5 pr-12">
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
          <RadixDialog.Close
            className="absolute top-4 right-4 rounded-md p-1 text-fg-subtle transition-colors hover:bg-subtle hover:text-fg"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden="true" />
          </RadixDialog.Close>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}
