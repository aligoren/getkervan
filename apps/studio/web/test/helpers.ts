// Driving the design system's Radix parts in jsdom, the way a keyboard user would.
import { fireEvent, screen } from "@testing-library/react"

/** Opens a "…" menu (Enter on its button) and picks an item. */
export async function chooseMenuItem(trigger: HTMLElement, item: string | RegExp): Promise<void> {
  fireEvent.keyDown(trigger, { key: "Enter" })
  fireEvent.click(await screen.findByRole("menuitem", { name: item }))
}

/** Opens a select (Enter on it) and picks an option. */
export async function chooseOption(trigger: HTMLElement, option: string | RegExp): Promise<void> {
  fireEvent.keyDown(trigger, { key: "Enter" })
  fireEvent.click(await screen.findByRole("option", { name: option }))
}

/** Opens a tab (Radix tabs switch on mouse down, like a native tab strip). */
export function openTab(name: string | RegExp): void {
  fireEvent.mouseDown(screen.getByRole("tab", { name }))
}
