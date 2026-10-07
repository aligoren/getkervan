import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { cn } from "./cn.js"

/**
 * A horizontally scrollable box that shows a soft fade on an edge while there is more content
 * past it, so a cut-off table or tab list reads as "scroll for more", not as broken.
 */
export function Scroller(props: {
  children: ReactNode
  className?: string
  innerClassName?: string
  /** The fade's color must match what is behind the content. */
  fade?: "surface" | "bg"
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const left = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    setEdges((current) =>
      current.left === left && current.right === right ? current : { left, right },
    )
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    for (const child of el.children) observer.observe(child)
    return () => observer.disconnect()
  }, [measure])

  const fade = props.fade === "bg" ? "from-bg" : "from-surface"
  return (
    <div className={cn("relative min-w-0", props.className)}>
      <div
        ref={ref}
        onScroll={measure}
        // relative: absolutely positioned (visually hidden) children stay inside this box.
        className={cn("relative overflow-x-auto overflow-y-hidden", props.innerClassName)}
      >
        {props.children}
      </div>
      <div
        aria-hidden="true"
        data-edge="left"
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r to-transparent transition-opacity duration-150",
          fade,
          edges.left ? "opacity-100" : "opacity-0",
        )}
      />
      <div
        aria-hidden="true"
        data-edge="right"
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l to-transparent transition-opacity duration-150",
          fade,
          edges.right ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  )
}
