import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from "react"
import { cn } from "./cn.js"
import { Scroller } from "./Scroller.js"

/**
 * A data table in a bordered box that scrolls sideways when the table is wider than the screen
 * (with a fade on the edge that has more), instead of overflowing the page. `dense` tightens
 * the rows.
 */
export function Table(props: {
  children: ReactNode
  dense?: boolean
  className?: string
  "aria-label"?: string
}) {
  return (
    <Scroller
      className={cn("overflow-hidden rounded-lg border border-border bg-surface", props.className)}
    >
      <table
        aria-label={props["aria-label"]}
        className={cn(
          "w-full border-collapse text-left text-sm",
          props.dense ? "[&_td]:py-2 [&_th]:py-2" : "[&_td]:py-3 [&_th]:py-2.5",
        )}
      >
        {props.children}
      </table>
    </Scroller>
  )
}

export function THead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-border bg-subtle">{children}</thead>
}

export function TBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-border">{children}</tbody>
}

export function TR({
  className,
  muted,
  ...rest
}: HTMLAttributes<HTMLTableRowElement> & { muted?: boolean }) {
  return (
    <tr
      className={cn(
        "transition-colors duration-150 hover:bg-subtle/60",
        muted && "text-fg-subtle [&_td]:text-fg-subtle",
        className,
      )}
      {...rest}
    />
  )
}

export function TH({ className, ...rest }: ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn(
        "px-4 text-xs font-medium tracking-wide whitespace-nowrap text-fg-muted uppercase",
        className,
      )}
      {...rest}
    />
  )
}

export function TD({ className, ...rest }: TdHTMLAttributes<HTMLTableCellElement>) {
  return <td className={cn("px-4 align-middle text-fg", className)} {...rest} />
}

/** A full-width row for an empty table. */
export function EmptyRow(props: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={props.colSpan} className="px-4 py-10 text-center text-sm text-fg-subtle">
        {props.children}
      </td>
    </tr>
  )
}
