// Before the first paint: the visitor's saved theme (light or dark) as data-theme on <html>.
// Without JavaScript the theme follows the system, and the header's radio buttons still work.
try {
  const theme = localStorage.getItem("kervan-theme")
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme
} catch {
  // Storage blocked: follow the system.
}
