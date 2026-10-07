import { useEffect, useState } from "react"
import { applyTheme, type ThemeChoice } from "./ui/ThemeToggle.js"

export type { ThemeChoice }
export { applyTheme }

/** Whether the page is dark right now (the user's choice, or the system's when "system"). */
export function isDark(): boolean {
  const chosen = document.documentElement.getAttribute("data-theme")
  if (chosen === "dark") return true
  if (chosen === "light") return false
  return window.matchMedia("(prefers-color-scheme: dark)").matches
}

/** Follows the effective theme (for parts that are not styled by CSS, like Monaco). */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(isDark)
  useEffect(() => {
    const update = () => setDark(isDark())
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    media.addEventListener("change", update)
    const observer = new MutationObserver(update)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    })
    return () => {
      media.removeEventListener("change", update)
      observer.disconnect()
    }
  }, [])
  return dark
}
