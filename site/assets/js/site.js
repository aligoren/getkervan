// Small enhancements; every page works without them.
// 1. The theme radios: remember the choice across pages (data-theme on <html>).
// 2. A copy button on code blocks.
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
    block.classList.add("has-copy")
    block.appendChild(button)
  }
})()
