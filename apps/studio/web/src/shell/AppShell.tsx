import * as RadixDialog from "@radix-ui/react-dialog"
import {
  LogOut,
  Menu as MenuIcon,
  ScrollText,
  Server,
  Settings,
  UserRound,
  Users,
  X,
} from "lucide-react"
import { type ReactNode, useEffect, useState } from "react"
import type { User } from "../api.js"
import { Button } from "../ui/Button.js"
import { cn } from "../ui/cn.js"
import { type ThemeChoice, ThemeToggle } from "../ui/ThemeToggle.js"
import { initials } from "./initials.js"

export type Section = "servers" | "users" | "audit" | "settings" | "profile"

interface NavItem {
  section: Section
  href: string
  label: string
  icon: ReactNode
  adminOnly?: boolean
}

const NAV: NavItem[] = [
  // Every signed-in user works on servers (members edit and publish specs).
  { section: "servers", href: "#/", label: "Servers", icon: <Server /> },
  { section: "users", href: "#/users", label: "Users", icon: <Users />, adminOnly: true },
  { section: "audit", href: "#/audit", label: "Audit log", icon: <ScrollText />, adminOnly: true },
  { section: "settings", href: "#/settings", label: "Settings", icon: <Settings /> },
  { section: "profile", href: "#/profile", label: "Profile", icon: <UserRound /> },
]

function Brand() {
  return (
    <a href="#/" className="flex items-center gap-2.5 text-fg no-underline hover:no-underline">
      <span
        aria-hidden="true"
        className="flex size-7 items-center justify-center rounded-md bg-accent text-sm font-bold text-accent-fg"
      >
        K
      </span>
      <span className="text-sm font-semibold tracking-tight">Kervan Studio</span>
    </a>
  )
}

/** The navigation, the theme switch and the signed-in user: the same in the sidebar and drawer. */
function Navigation(props: {
  user: User
  section: Section
  theme: ThemeChoice
  onTheme: (choice: ThemeChoice) => void
  onSignOut: () => void
  onNavigate?: () => void
}) {
  const isAdmin = props.user.role === "admin"
  return (
    <div className="flex h-full flex-col">
      <nav aria-label="Main" className="flex-1 space-y-0.5 px-3 py-4">
        {NAV.filter((item) => !item.adminOnly || isAdmin).map((item) => {
          const active = item.section === props.section
          return (
            <a
              key={item.section}
              href={item.href}
              onClick={props.onNavigate}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm font-medium no-underline transition-colors duration-150 hover:no-underline [&_svg]:size-4",
                active ? "bg-subtle text-fg" : "text-fg-muted hover:bg-subtle/70 hover:text-fg",
              )}
            >
              <span className={active ? "text-accent-text" : "text-fg-subtle"}>{item.icon}</span>
              {item.label}
            </a>
          )
        })}
      </nav>
      <div className="space-y-3 border-t border-border px-3 py-4">
        <ThemeToggle value={props.theme} onChange={props.onTheme} compact />
        <div className="flex items-center gap-2.5 px-1">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold text-fg-muted"
          >
            {initials(props.user)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-fg">
              {props.user.displayName || props.user.email}
            </p>
            <p className="truncate text-xs text-fg-subtle" title={props.user.email}>
              {props.user.displayName ? `${props.user.email} · ` : ""}
              {props.user.role}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onSignOut}
            aria-label="Sign out"
            title="Sign out"
          >
            <LogOut className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * The signed-in layout: a sidebar on wide screens, a top bar with a drawer on narrow ones, and
 * the page in a centered column.
 */
export function AppShell(props: {
  user: User
  section: Section
  theme: ThemeChoice
  onTheme: (choice: ThemeChoice) => void
  onSignOut: () => void
  /** Room for side-by-side work areas (the server page's editor and playground). */
  wide?: boolean
  children: ReactNode
}) {
  const [drawer, setDrawer] = useState(false)
  // Navigating closes the drawer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: close when the page changes
  useEffect(() => setDrawer(false), [props.section])

  const navigation = (onNavigate?: () => void) => (
    <Navigation
      user={props.user}
      section={props.section}
      theme={props.theme}
      onTheme={props.onTheme}
      onSignOut={props.onSignOut}
      {...(onNavigate ? { onNavigate } : {})}
    />
  )

  return (
    <div className="min-h-dvh bg-bg">
      <a
        href="#main"
        className="visually-hidden focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2"
      >
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-surface lg:flex">
        <div className="flex h-14 items-center border-b border-border px-5">
          <Brand />
        </div>
        {navigation()}
      </aside>

      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-border bg-surface/95 px-4 backdrop-blur lg:hidden">
        <Brand />
        <RadixDialog.Root open={drawer} onOpenChange={setDrawer}>
          <RadixDialog.Trigger asChild>
            <Button variant="ghost" size="icon" aria-label="Open the menu">
              <MenuIcon className="size-5" aria-hidden="true" />
            </Button>
          </RadixDialog.Trigger>
          <RadixDialog.Portal>
            <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/40 data-[state=open]:animate-[fade-in_150ms_ease-out]" />
            <RadixDialog.Content className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-border bg-surface shadow-lg data-[state=open]:animate-[drawer-in_150ms_ease-out]">
              <div className="flex h-14 items-center justify-between border-b border-border px-4">
                <RadixDialog.Title asChild>
                  <div>
                    <Brand />
                  </div>
                </RadixDialog.Title>
                <RadixDialog.Description className="visually-hidden">
                  Navigation
                </RadixDialog.Description>
                <RadixDialog.Close asChild>
                  <Button variant="ghost" size="icon" aria-label="Close the menu">
                    <X className="size-5" aria-hidden="true" />
                  </Button>
                </RadixDialog.Close>
              </div>
              {navigation(() => setDrawer(false))}
            </RadixDialog.Content>
          </RadixDialog.Portal>
        </RadixDialog.Root>
      </header>

      <main id="main" className="lg:pl-60">
        <div
          className={cn(
            "mx-auto w-full px-4 py-6 sm:px-6 lg:px-10 lg:py-8",
            props.wide ? "max-w-[100rem]" : "max-w-6xl",
          )}
        >
          {props.children}
        </div>
      </main>
    </div>
  )
}
