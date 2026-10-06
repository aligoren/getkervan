import type { MutableToolRegistry } from "@kervan/core"
import { type CompiledDefinition, compilePlan } from "./compile.js"
import { type LoadedSpec, type LoadOptions, SpecLoadError } from "./load.js"
import { planTool, type SpecIssue } from "./plan.js"
import { envSecrets, normalizeHost, SecretVault } from "./secrets.js"
import { type SpecTool, specToolSchema } from "./spec-schema.js"

// Public API. The security building blocks (address checks, pinned lookups, template parsing,
// schema limits) stay internal: their behavior is tested, their signatures are not a contract.
export type { CompiledDefinition } from "./compile.js"
export {
  type CompiledTool,
  formatIssue,
  type LoadedSpec,
  type LoadOptions,
  loadSpec,
  SpecLoadError,
} from "./load.js"
export {
  LookupGate,
  type NetworkPolicy,
  NetworkPolicyError,
  type ResolvedAddress,
  type Resolver,
} from "./network.js"
export type { SpecIssue } from "./plan.js"
export { SCHEMA_LIMITS } from "./schema-limits.js"
export {
  envSecrets,
  normalizeHost,
  REDACTED,
  type SecretContext,
  SecretError,
  type SecretSource,
  SecretVault,
} from "./secrets.js"
export {
  HTTP_DEFAULTS,
  SPEC_LIMITS,
  type Spec,
  type SpecTool,
  specJsonSchema,
} from "./spec-schema.js"

/**
 * Adds a loaded spec's tools to a registry, or updates it after a reload: tools whose spec did not
 * change keep their registry entry, so clients only get `list_changed` for real changes.
 * Returns the signatures to pass to the next call.
 */
export function applySpec(
  registry: MutableToolRegistry,
  loaded: LoadedSpec,
  previous: ReadonlyMap<string, string> = new Map(),
): Map<string, string> {
  const next = new Map<string, string>()
  for (const name of previous.keys()) {
    if (!loaded.tools.some((tool) => tool.name === name)) registry.remove(name)
  }
  for (const tool of loaded.tools) {
    next.set(tool.name, tool.signature)
    const before = previous.get(tool.name)
    if (before === tool.signature) continue
    const method = before === undefined ? "add" : "replace"
    const definition = tool.definition
    if ("output" in definition && definition.output !== undefined)
      registry[method](tool.name, definition)
    else
      registry[method](tool.name, definition as Extract<CompiledDefinition, { output?: undefined }>)
  }
  return next
}

/**
 * The code API behind the spec: builds an `app.tool()` definition from the same object a
 * kervan.yaml tool has, with the same validation.
 *
 *   app.tool(...httpTool({ name: "get_weather", description: "...", http: {...}, output: {...} }))
 *
 * @experimental The signature may change before 1.0.
 */
export function httpTool(
  tool: unknown,
  options: Omit<LoadOptions, "fileName" | "requireSecrets"> & {
    /** Secrets the tool may use: names, or `{ name, hosts }` to bind one to hosts. */
    secretNames?: readonly (string | { name: string; hosts: readonly string[] })[]
  } = {},
): [string, CompiledDefinition] {
  const issues: SpecIssue[] = []
  const parsed = specToolSchema.safeParse(tool)
  if (!parsed.success) {
    throw new SpecLoadError(
      "httpTool",
      parsed.error.issues.map((issue) => ({
        path: issue.path as (string | number)[],
        message: issue.message,
        severity: "error" as const,
      })),
    )
  }
  const declared = options.secretNames ? bindings(options.secretNames) : undefined
  const plan = planTool(
    parsed.data as SpecTool,
    undefined,
    declared,
    [],
    (path, message, severity = "error") => {
      issues.push({ path, message, severity })
    },
  )
  const errors = issues.filter((issue) => issue.severity === "error")
  if (!plan || errors.length > 0) throw new SpecLoadError("httpTool", errors)
  const definition = compilePlan(plan, {
    secrets: options.secrets ?? envSecrets(),
    vault: options.vault ?? new SecretVault(),
    ...(options.network ? { network: options.network } : {}),
  })
  return [plan.name, definition]
}

function bindings(
  entries: readonly (string | { name: string; hosts: readonly string[] })[],
): Map<string, readonly string[] | undefined> {
  const declared = new Map<string, readonly string[] | undefined>()
  for (const entry of entries) {
    if (typeof entry === "string") {
      declared.set(entry, undefined)
      continue
    }
    const hosts = entry.hosts.map((host) => {
      const normalized = normalizeHost(host)
      if (normalized === undefined) {
        throw new SpecLoadError("httpTool", [
          { path: ["secretNames"], message: `"${host}" is not a host name.`, severity: "error" },
        ])
      }
      return normalized
    })
    if (hosts.length === 0) {
      throw new SpecLoadError("httpTool", [
        {
          path: ["secretNames"],
          message: `Secret ${entry.name} needs at least one host.`,
          severity: "error",
        },
      ])
    }
    declared.set(entry.name, hosts)
  }
  return declared
}
