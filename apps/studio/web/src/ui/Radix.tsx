// Thin, styled wrappers over Radix primitives: tabs, a dropdown menu, a tooltip and a select.
import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import * as RadixSelect from "@radix-ui/react-select"
import * as RadixTabs from "@radix-ui/react-tabs"
import * as RadixTooltip from "@radix-ui/react-tooltip"
import { Check, ChevronDown } from "lucide-react"
import { type ReactNode, useId } from "react"
import { cn } from "./cn.js"
import { Scroller } from "./Scroller.js"

export function Tabs(props: {
  value: string
  onValueChange: (value: string) => void
  items: { value: string; label: ReactNode; count?: number }[]
  children?: ReactNode
  "aria-label"?: string
}) {
  return (
    <RadixTabs.Root value={props.value} onValueChange={props.onValueChange}>
      <Scroller fade="bg" className="border-b border-border">
        <RadixTabs.List aria-label={props["aria-label"]} className="flex w-max min-w-full gap-1">
          {props.items.map((item) => (
            <RadixTabs.Trigger
              key={item.value}
              value={item.value}
              className={cn(
                "-mb-px inline-flex h-10 cursor-pointer items-center gap-1.5 border-b-2 border-transparent px-3 text-sm font-medium whitespace-nowrap text-fg-muted",
                "transition-colors duration-150 hover:text-fg",
                "data-[state=active]:border-accent data-[state=active]:text-fg",
              )}
            >
              {item.label}
              {item.count !== undefined ? (
                <span className="rounded-full bg-subtle px-1.5 text-xs text-fg-subtle">
                  {item.count}
                </span>
              ) : null}
            </RadixTabs.Trigger>
          ))}
        </RadixTabs.List>
      </Scroller>
      {props.children}
    </RadixTabs.Root>
  )
}

/** A tab's content. `keepMounted` keeps it (hidden) while another tab is open, e.g. an editor. */
export const TabPanel = (props: { value: string; children: ReactNode; keepMounted?: boolean }) => (
  <RadixTabs.Content
    value={props.value}
    {...(props.keepMounted ? { forceMount: true as const } : {})}
    className="pt-5 focus-visible:outline-none data-[state=inactive]:hidden"
  >
    {props.children}
  </RadixTabs.Content>
)

export interface MenuItem {
  label: ReactNode
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

/** A "…" style menu of actions. */
export function Menu(props: {
  trigger: ReactNode
  items: (MenuItem | "separator")[]
  label: string
}) {
  return (
    <RadixMenu.Root>
      <RadixMenu.Trigger asChild aria-label={props.label}>
        {props.trigger}
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-48 rounded-lg border border-border bg-surface p-1 text-sm shadow-lg data-[state=open]:animate-[fade-in_150ms_ease-out]"
        >
          {props.items.map((item, index) =>
            item === "separator" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: separators have no identity
              <RadixMenu.Separator key={`sep-${index}`} className="my-1 h-px bg-border" />
            ) : (
              <RadixMenu.Item
                // biome-ignore lint/suspicious/noArrayIndexKey: the list is static per render
                key={index}
                disabled={item.disabled ?? false}
                onSelect={item.onSelect}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-md px-2.5 py-1.5 outline-none select-none",
                  "data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-subtle",
                  item.danger ? "text-danger" : "text-fg",
                )}
              >
                {item.icon ? (
                  <span className="size-4 shrink-0 [&_svg]:size-4">{item.icon}</span>
                ) : null}
                {item.label}
              </RadixMenu.Item>
            ),
          )}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  )
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <RadixTooltip.Provider delayDuration={300}>{children}</RadixTooltip.Provider>
}

/** A short hint on hover or focus. Not for anything the user must read to proceed. */
export function Tooltip(props: { content: ReactNode; children: ReactNode }) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{props.children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content
          sideOffset={6}
          className="z-50 max-w-xs rounded-md bg-fg px-2.5 py-1.5 text-xs text-bg shadow-lg data-[state=delayed-open]:animate-[fade-in_150ms_ease-out]"
        >
          {props.content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  )
}

/**
 * A disabled control with the reason it is disabled: shown in a tooltip on hover or keyboard
 * focus, and read to screen readers (a disabled button gets no events, so the wrapper does).
 */
export function DisabledReason(props: { reason: string; children: ReactNode }) {
  const id = useId()
  return (
    <RadixTooltip.Provider delayDuration={150}>
      <Tooltip content={props.reason}>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the reason must be reachable by keyboard */}
        <span tabIndex={0} aria-describedby={id} className="inline-flex rounded-md">
          {props.children}
          <span id={id} className="visually-hidden">
            {props.reason}
          </span>
        </span>
      </Tooltip>
    </RadixTooltip.Provider>
  )
}

/**
 * The one select of the design system (Radix: keyboard, typeahead and screen readers work; a
 * hidden native select keeps form semantics). Works inside a Field, which sets its id.
 */
export function Select(props: {
  value: string
  onValueChange: (value: string) => void
  options: { value: string; label: ReactNode; disabled?: boolean }[]
  "aria-label"?: string
  "aria-describedby"?: string
  "aria-invalid"?: boolean
  id?: string
  placeholder?: string
  disabled?: boolean
  className?: string
}) {
  return (
    <RadixSelect.Root
      value={props.value}
      onValueChange={props.onValueChange}
      disabled={props.disabled ?? false}
    >
      <RadixSelect.Trigger
        id={props.id}
        aria-label={props["aria-label"]}
        aria-describedby={props["aria-describedby"]}
        aria-invalid={props["aria-invalid"]}
        className={cn(
          "inline-flex h-9 cursor-pointer items-center justify-between gap-2 rounded-md border border-border-input bg-control px-3 text-sm text-fg shadow-xs",
          "transition-colors duration-150 hover:bg-control-hover",
          props.className,
        )}
      >
        <RadixSelect.Value placeholder={props.placeholder} />
        <RadixSelect.Icon>
          <ChevronDown className="size-4 text-fg-subtle" aria-hidden="true" />
        </RadixSelect.Icon>
      </RadixSelect.Trigger>
      <RadixSelect.Portal>
        <RadixSelect.Content
          position="popper"
          sideOffset={4}
          className="z-50 min-w-[var(--radix-select-trigger-width)] rounded-lg border border-border bg-surface p-1 text-sm shadow-lg"
        >
          <RadixSelect.Viewport>
            {props.options.map((option) => (
              <RadixSelect.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled ?? false}
                className="relative flex cursor-pointer items-center rounded-md py-1.5 pr-2 pl-7 outline-none select-none data-[highlighted]:bg-subtle"
              >
                <RadixSelect.ItemIndicator className="absolute left-2">
                  <Check className="size-4 text-accent-text" aria-hidden="true" />
                </RadixSelect.ItemIndicator>
                <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
              </RadixSelect.Item>
            ))}
          </RadixSelect.Viewport>
        </RadixSelect.Content>
      </RadixSelect.Portal>
    </RadixSelect.Root>
  )
}
