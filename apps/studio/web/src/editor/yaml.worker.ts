// Vite bundles this file as its own same-origin worker (see monaco-yaml's notes on Vite).
// The shim must run first: ES modules evaluate in import order.
import "./process-shim.js"
import "monaco-yaml/yaml.worker.js"
