import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "../ui/theme.css"
import { Styleguide } from "./Styleguide.js"

// Development only (see styleguide.html): the production build has a single entry, index.html.
const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Styleguide />
    </StrictMode>,
  )
}
