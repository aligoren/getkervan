import { fileURLToPath } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const root = fileURLToPath(new URL(".", import.meta.url))
export default defineConfig({
  root,
  base: "/",
  // Tailwind runs at build time; the output is plain CSS served from Studio's own origin.
  plugins: [react(), tailwindcss()],
  build: {
    outDir: fileURLToPath(new URL("../dist-web", import.meta.url)),
    emptyOutDir: true,
    // Only the app: the styleguide (styleguide.html) is a development page and never ships.
    rollupOptions: { input: fileURLToPath(new URL("index.html", import.meta.url)) },
    // Monaco is large; it is loaded only on the server page.
    chunkSizeWarningLimit: 8000,
  },
  worker: { format: "es" },
  server: {
    // `vite` (development) forwards API and gateway calls to a running Studio.
    // "/s/" with the slash: a bare "/s" prefix would also catch /src and /styleguide.html.
    proxy: { "/api": "http://127.0.0.1:4310", "/s/": "http://127.0.0.1:4310" },
  },
})
