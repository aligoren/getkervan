// Search on /search/: filters a small index built with the site (no server, no third party).
// Without JavaScript the page lists every page instead.
void (async () => {
  const form = document.querySelector("form[data-index]")
  const input = document.getElementById("search-input")
  const list = document.getElementById("search-results")
  const status = document.getElementById("search-status")
  if (!form || !input || !list || !status) return
  let pages = []
  try {
    pages = await (await fetch(form.dataset.index)).json()
  } catch {
    return
  }
  form.hidden = false
  const render = () => {
    const words = input.value
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 1)
    list.replaceChildren()
    if (words.length === 0) {
      status.textContent = ""
      return
    }
    const scored = pages
      .map((page) => {
        const title = page.title.toLowerCase()
        const body = `${page.description} ${page.text}`.toLowerCase()
        let score = 0
        for (const word of words) {
          if (title.includes(word)) score += 5
          else if (body.includes(word)) score += 1
          else return undefined
        }
        return { page, score }
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20)
    status.textContent = `${scored.length} page${scored.length === 1 ? "" : "s"} found.`
    for (const { page } of scored) {
      const item = document.createElement("li")
      const link = document.createElement("a")
      link.href = page.url
      link.textContent = page.title
      const text = document.createElement("p")
      text.textContent = page.description
      item.append(link, text)
      list.append(item)
    }
  }
  input.addEventListener("input", render)
  form.addEventListener("submit", (event) => event.preventDefault())
  const query = new URLSearchParams(location.search).get("q")
  if (query) {
    input.value = query
    render()
  }
})()
