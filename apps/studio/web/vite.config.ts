import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const root = fileURLToPath(new URL(".", import.meta.url))
export default defineConfig({
  root,
  base: "/",
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("../dist-web", import.meta.url)),
    emptyOutDir: true,
    // Monaco is large; it is loaded only on the server page.
    chunkSizeWarningLimit: 8000,
  },
  worker: { format: "es" },
  server: {
    // `vite` (development) forwards API and gateway calls to a running Studio.
    proxy: { "/api": "http://127.0.0.1:4310", "/s": "http://127.0.0.1:4310" },
  },
})
