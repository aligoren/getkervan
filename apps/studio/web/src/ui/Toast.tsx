import { CircleAlert, CircleCheck, X } from "lucide-react"
import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react"
import { cn } from "./cn.js"

interface ToastItem {
  id: number
  message: string
  tone: "success" | "danger" | "neutral"
}

type Notify = (message: string, tone?: ToastItem["tone"]) => void

const ToastContext = createContext<Notify>(() => {})

/** Shows a short message ("Copied", "Saved") for a few seconds. */
export function useToast(): Notify {
  return useContext(ToastContext)
}

/**
 * Holds the toasts. Messages are announced politely to screen readers (role="status"); errors
 * that block the user belong in the page or the dialog, not only in a toast.
 */
export function ToastProvider(props: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const next = useRef(0)

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id))
  }, [])

  const notify = useCallback<Notify>(
    (message, tone = "success") => {
      const id = next.current++
      setItems((current) => [...current.slice(-3), { id, message, tone }])
      setTimeout(() => dismiss(id), 4000)
    },
    [dismiss],
  )

  return (
    <ToastContext.Provider value={notify}>
      {props.children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2"
      >
        {items.map((item) => (
          <div
            key={item.id}
            className={cn(
              "pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3.5 py-3 text-sm shadow-lg",
              "animate-[toast-in_150ms_ease-out]",
            )}
          >
            {item.tone === "danger" ? (
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
            ) : (
              <CircleCheck
                className={cn(
                  "mt-0.5 size-4 shrink-0",
                  item.tone === "success" ? "text-success" : "text-fg-subtle",
                )}
                aria-hidden="true"
              />
            )}
            <span className="min-w-0 flex-1 text-fg">{item.message}</span>
            <button
              type="button"
              onClick={() => dismiss(item.id)}
              className="-m-1 rounded p-1 text-fg-subtle hover:text-fg"
              aria-label="Dismiss"
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
