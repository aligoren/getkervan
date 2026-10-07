// Whether the person is using a pointer or the keyboard, as `<html data-modality>`. theme.css hides
// focus rings while it is "pointer": browsers keep a ring after a click when focus then moves by
// script (menus, dialogs), or as soon as any key is pressed, even Shift. Keyboard navigation turns
// rings back on, and text fields always show theirs (that is where the caret is).

/** Keys that navigate or act. Typing text, or holding a modifier, does not count. */
const NAVIGATION_KEYS = new Set([
  "Tab",
  "Enter",
  "Escape",
  " ",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
])
/** Inside a text field these keys edit text: they say nothing about navigation. */
const EDITING_KEYS = new Set([" ", "ArrowLeft", "ArrowRight", "Home", "End"])

function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true
  return (
    target instanceof HTMLInputElement &&
    !["checkbox", "radio", "button", "submit", "reset"].includes(target.type)
  )
}

/** Starts tracking; returns a function that stops it. */
export function trackInputModality(root: HTMLElement = document.documentElement): () => void {
  const pointer = () => root.setAttribute("data-modality", "pointer")
  const key = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (!NAVIGATION_KEYS.has(event.key)) return
    if (EDITING_KEYS.has(event.key) && isTextField(event.target)) return
    root.setAttribute("data-modality", "keyboard")
  }
  document.addEventListener("pointerdown", pointer, true)
  document.addEventListener("keydown", key, true)
  return () => {
    document.removeEventListener("pointerdown", pointer, true)
    document.removeEventListener("keydown", key, true)
  }
}
