// Small enhancements; every page works without them.
// 1. The theme radios: remember the choice across pages (data-theme on <html>).
// 2. A copy button on code blocks.
// 3. Tabs for the home page's example.
;(() => {
  const root = document.documentElement
  const saved = root.dataset.theme
  const radio = document.getElementById(`theme-${saved || "system"}`)
  if (radio) radio.checked = true
  for (const input of document.querySelectorAll('input[name="theme"]')) {
    input.addEventListener("change", () => {
      const value = input.value
      try {
        if (value === "system") localStorage.removeItem("kervan-theme")
        else localStorage.setItem("kervan-theme", value)
      } catch {
        // Storage blocked: the choice lasts for this page.
      }
      if (value === "system") delete root.dataset.theme
      else root.dataset.theme = value
    })
  }

  // 3. Tabs ([data-tabs], the home page's example). Without JavaScript every panel shows under its
  // heading; here they become tabs, the first selected (the WAI-ARIA tabs pattern: the selected
  // tab is the one in the Tab order, arrow keys, Home and End move between tabs).
  for (const group of document.querySelectorAll("[data-tabs]")) {
    const panels = [...group.children].filter((child) => child.classList.contains("example-panel"))
    if (panels.length < 2) continue
    const list = document.createElement("div")
    list.className = "example-tablist"
    list.setAttribute("role", "tablist")
    const tabs = panels.map((panel) => {
      const heading = panel.querySelector(".example-heading")
      const tab = document.createElement("button")
      tab.type = "button"
      tab.className = "example-tab"
      tab.id = `${panel.id}-tab`
      tab.textContent = heading ? heading.textContent : panel.id
      tab.setAttribute("role", "tab")
      tab.setAttribute("aria-controls", panel.id)
      panel.setAttribute("role", "tabpanel")
      panel.setAttribute("aria-labelledby", tab.id)
      if (heading) heading.hidden = true
      list.appendChild(tab)
      return tab
    })
    const select = (index, focus) => {
      tabs.forEach((tab, i) => {
        tab.setAttribute("aria-selected", String(i === index))
        tab.tabIndex = i === index ? 0 : -1
        panels[i].hidden = i !== index
      })
      if (focus) tabs[index].focus()
    }
    list.addEventListener("click", (event) => {
      const index = tabs.indexOf(event.target.closest('[role="tab"]'))
      if (index >= 0) select(index, false)
    })
    list.addEventListener("keydown", (event) => {
      const current = tabs.indexOf(document.activeElement)
      const next = {
        ArrowRight: current + 1,
        ArrowLeft: current - 1,
        Home: 0,
        End: tabs.length - 1,
      }[event.key]
      if (current < 0 || next === undefined) return
      event.preventDefault()
      select((next + tabs.length) % tabs.length, true)
    })
    group.prepend(list)
    select(0, false)
  }

  if (!navigator.clipboard) return
  // One polite live region says what a copy button did; the buttons keep a fixed name.
  const status = document.createElement("p")
  status.className = "visually-hidden"
  status.setAttribute("role", "status")
  document.body.appendChild(status)
  const announce = (text) => {
    status.textContent = ""
    setTimeout(() => {
      status.textContent = text
    }, 50)
  }
  for (const block of document.querySelectorAll(".code")) {
    const code = block.querySelector("pre code")
    if (!code) continue
    const button = document.createElement("button")
    button.type = "button"
    button.className = "copy"
    button.textContent = "Copy"
    button.setAttribute("aria-label", "Copy this code")
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.innerText.replace(/\n$/, ""))
        button.textContent = "Copied"
        announce("Copied to the clipboard.")
      } catch {
        button.textContent = "Select and copy"
        announce("Could not copy: select the code and copy it.")
      }
      setTimeout(() => {
        button.textContent = "Copy"
      }, 1600)
    })
    ;(block.querySelector(".code-head") ?? block).appendChild(button)
  }
})()
