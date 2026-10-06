// The YAML language server resolves relative `$schema` paths with a Node-style `path` module that
// reads `process.cwd()`; browsers have no `process`. Schemas are never fetched (see SpecEditor),
// so a fixed working directory is enough.
const scope = globalThis as { process?: unknown }
scope.process ??= { cwd: () => "/", env: {}, platform: "browser" }
