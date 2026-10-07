import { Monitor, Moon, Sun } from "lucide-react"
import { cn } from "./cn.js"

export type ThemeChoice = "system" | "light" | "dark"

/** Applies a theme choice to the page (`<html data-theme>`; "system" follows the OS). */
export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement
  if (choice === "system") root.removeAttribute("data-theme")
  else root.setAttribute("data-theme", choice)
}

const choices: { value: ThemeChoice; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
]

/** A three-way switch: system, light, dark (toggle buttons; the pressed one is the choice). */
export function ThemeToggle(props: {
  value: ThemeChoice
  onChange: (choice: ThemeChoice) => void
}) {
  return (
    <fieldset className="m-0 inline-flex min-w-0 rounded-md border border-border bg-subtle p-0.5">
      <legend className="visually-hidden">Theme</legend>
      {choices.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          aria-pressed={props.value === value}
          onClick={() => props.onChange(value)}
          title={label}
          className={cn(
            "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors duration-150",
            props.value === value ? "bg-surface text-fg shadow-xs" : "text-fg-muted hover:text-fg",
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
          <span>{label}</span>
        </button>
      ))}
    </fieldset>
  )
}
