import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.js"
import { trackInputModality } from "./modality.js"
import "./ui/theme.css"

trackInputModality()

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
