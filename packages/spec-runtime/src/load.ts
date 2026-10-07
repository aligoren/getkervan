import { LineCounter, parseDocument } from "yaml"
import type * as z from "zod"
import { type CompiledDefinition, compilePlan, type RuntimeOptions } from "./compile.js"
import { type IssuePath, planTool, type SpecIssue, type ToolPlan } from "./plan.js"
import {
  envSecrets,
  normalizeHostPort,
  SecretError,
  type SecretSource,
  SecretVault,
} from "./secrets.js"
import { SPEC_LIMITS, type Spec, type SpecTool, specSchema } from "./spec-schema.js"

export interface CompiledTool {
  name: string
  definition: CompiledDefinition
  /** Changes whenever the tool's spec changes; equal signatures mean an identical tool. */
  signature: string
}

export interface LoadedSpec {
  spec: Spec
  tools: CompiledTool[]
  warnings: SpecIssue[]
  vault: SecretVault
}

export interface LoadOptions {
  /** Shown in error messages, e.g. `kervan.yaml:12:5`. Default: `kervan.yaml`. */
  fileName?: string
  /** Default: environment variables. */
  secrets?: SecretSource
  /** Shared across reloads so earlier secret values stay redacted. Default: a new vault. */
  vault?: SecretVault
  /** SSRF policy for outgoing requests. Default: public unicast addresses only. */
  network?: RuntimeOptions["network"]
  /**
   * Fail when a secret a tool uses is not available for that tool's host, instead of warning.
   * Use it to validate a spec before publishing it. Default: false.
   */
  requireSecrets?: boolean
  /**
   * Allow tools that use secrets to call plain http URLs. Off by default: secrets never travel
   * unencrypted. For local development against an http API only.
   */
  allowSecretsOverHttp?: boolean
}

/** Added after structural problems: the remaining checks run once the structure is valid. */
export const STRUCTURE_FIRST =
  "Fix these structure problems first: more checks (URLs, template references, secrets) run " +
  "once the structure is valid, and may report more problems."

export class SpecLoadError extends Error {
  override name = "SpecLoadError"
  readonly issues: SpecIssue[]

  constructor(fileName: string, issues: SpecIssue[]) {
    super(
      `${fileName} is not a valid Kervan spec:\n${issues.map((issue) => `  ${formatIssue(fileName, issue)}`).join("\n")}`,
    )
    this.issues = issues
  }
}

export function formatIssue(fileName: string, issue: SpecIssue): string {
  const where = issue.line === undefined ? fileName : `${fileName}:${issue.line}:${issue.column}`
  const path = formatPath(issue.path)
  return `${where}${path ? ` ${path}` : ""}: ${issue.message}`
}

function formatPath(path: IssuePath): string {
  return path
    .map((key, i) => (typeof key === "number" ? `[${key}]` : i === 0 ? key : `.${key}`))
    .join("")
}

/**
 * Parses, validates and compiles a kervan.yaml spec. Throws `SpecLoadError` listing every problem
 * with its line and column. Declared secrets are resolved once here, so short or missing values
 * are reported before the server starts.
 */
export async function loadSpec(text: string, options: LoadOptions = {}): Promise<LoadedSpec> {
  const fileName = options.fileName ?? "kervan.yaml"
  if (Buffer.byteLength(text) > SPEC_LIMITS.maxSpecBytes) {
    throw new SpecLoadError(fileName, [
      {
        path: [],
        message: `The spec is larger than ${SPEC_LIMITS.maxSpecBytes} bytes.`,
        severity: "error",
      },
    ])
  }

  const lineCounter = new LineCounter()
  const doc = parseDocument(text, { lineCounter, uniqueKeys: true, prettyErrors: false })
  const issues: SpecIssue[] = []
  const at = (path: IssuePath, message: string, severity: "error" | "warning" = "error") => {
    issues.push({ path, message, severity, ...position(doc, lineCounter, path) })
  }
  for (const problem of [...doc.errors, ...doc.warnings]) {
    const pos = lineCounter.linePos(problem.pos[0])
    issues.push({
      path: [],
      message: problem.message.split("\n")[0] ?? problem.message,
      severity: "error",
      line: pos.line,
      column: pos.col,
    })
  }
  if (issues.length > 0) throw new SpecLoadError(fileName, issues)

  let data: unknown
  try {
    // Bounded alias expansion guards against "billion laughs" documents.
    data = doc.toJS({ maxAliasCount: 50 })
  } catch (error) {
    throw new SpecLoadError(fileName, [
      { path: [], message: (error as Error).message, severity: "error" },
    ])
  }

  const parsed = specSchema.safeParse(data)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      at(issue.path as IssuePath, zodMessage(issue, data))
    }
    // The other checks (URLs, template references, secrets) need a well-formed spec, so they
    // wait until the structure is fixed. Say so, rather than let a second round surprise.
    issues.push({ path: [], message: STRUCTURE_FIRST, severity: "warning" })
    throw new SpecLoadError(fileName, issues)
  }
  const spec = parsed.data

  const declared = declaredSecrets(spec, at)
  const used = new Set<string>()
  const names = new Set<string>()
  const plans: [SpecTool, ToolPlan, number][] = []
  spec.tools.forEach((tool, index) => {
    if (names.has(tool.name)) at(["tools", index, "name"], `Duplicate tool name "${tool.name}".`)
    names.add(tool.name)
    const plan = planTool(tool, spec.defaults, declared, ["tools", index], at, {
      allowSecretsOverHttp: options.allowSecretsOverHttp === true,
    })
    if (plan) {
      for (const name of plan.secrets) used.add(name)
      plans.push([tool, plan, index])
    }
  })
  const secretIndex = new Map((spec.secrets ?? []).map((entry, i) => [secretEntryName(entry), i]))
  for (const name of declared.keys()) {
    if (!used.has(name)) {
      at(
        ["secrets", secretIndex.get(name) ?? 0],
        `Secret ${name} is declared but never used.`,
        "warning",
      )
    }
  }

  // Each secret is asked for once per host it is sent to, the way calls ask for it, so a source
  // that binds secrets to hosts is checked before the server starts.
  const source = options.secrets ?? envSecrets()
  const vault = options.vault ?? new SecretVault()
  const asked = new Set<string>()
  for (const [, plan, index] of plans) {
    for (const name of plan.secrets) {
      const key = JSON.stringify([name, plan.host])
      if (asked.has(key)) continue
      asked.add(key)
      const path = ["secrets", secretIndex.get(name) ?? 0]
      const value = await source.get(name, { host: plan.host, tool: plan.name })
      if (value === undefined || value === "") {
        // Point at the URL that would receive the secret: that is the line to fix.
        if (options.requireSecrets) {
          at(
            ["tools", index, "http", "url"],
            `Secret ${name} is not configured for ${plan.host}, so tool "${plan.name}" cannot send it there.`,
          )
        } else {
          at(
            path,
            `Secret ${name} is not configured for ${plan.host}; tools that use it there fail until it is.`,
            "warning",
          )
        }
        continue
      }
      try {
        vault.add(name, value)
      } catch (error) {
        if (error instanceof SecretError) at(path, error.message)
        else throw error
      }
    }
  }

  const errors = issues.filter((issue) => issue.severity === "error")
  if (errors.length > 0) throw new SpecLoadError(fileName, errors)

  const runtime: RuntimeOptions = {
    secrets: source,
    vault,
    ...(options.network ? { network: options.network } : {}),
    allowSecretsOverHttp: options.allowSecretsOverHttp === true,
  }
  const tools = plans.map(([tool, plan]) => ({
    name: plan.name,
    definition: compilePlan(plan, runtime),
    // Bindings change what a tool may do, so they are part of its identity.
    signature: JSON.stringify([tool, spec.defaults ?? null, [...plan.secretHosts]]),
  }))
  return { spec, tools, warnings: issues.filter((issue) => issue.severity === "warning"), vault }
}

function secretEntryName(entry: NonNullable<Spec["secrets"]>[number]): string {
  return typeof entry === "string" ? entry : entry.name
}

/** Declared secret names with their normalized host bindings (`undefined` when unbound). */
function declaredSecrets(
  spec: Spec,
  at: (path: IssuePath, message: string) => void,
): Map<string, readonly string[] | undefined> {
  const declared = new Map<string, readonly string[] | undefined>()
  ;(spec.secrets ?? []).forEach((entry, index) => {
    const name = secretEntryName(entry)
    if (declared.has(name)) at(["secrets", index], `Secret ${name} is declared twice.`)
    if (typeof entry === "string") {
      declared.set(name, undefined)
      return
    }
    const hosts: string[] = []
    entry.hosts.forEach((host, i) => {
      const normalized = normalizeHostPort(host)
      if (normalized === undefined) {
        at(["secrets", index, "hosts", i], `"${host}" is not a host name.`)
      } else if (!hosts.includes(normalized)) hosts.push(normalized)
    })
    declared.set(name, hosts)
  })
  return declared
}

/** The line and column of the YAML node at `path`, or of its nearest existing parent. */
function position(doc: ReturnType<typeof parseDocument>, counter: LineCounter, path: IssuePath) {
  for (let length = path.length; length >= 0; length--) {
    const node = doc.getIn(path.slice(0, length), true) as
      | { range?: [number, number, number] }
      | undefined
    if (node?.range) {
      const { line, col } = counter.linePos(node.range[0])
      return { line, column: col }
    }
  }
  return {}
}

function zodMessage(issue: z.core.$ZodIssue, data: unknown): string {
  if (issue.code === "unrecognized_keys") return `Unknown field(s): ${issue.keys.join(", ")}.`
  // `api.example.com: 8443` (a space after the colon) is a one-entry mapping in YAML, not a
  // host:port string. Zod reports it on the host or, through the union, on the whole entry.
  if (issue.path[0] === "secrets") {
    const entry = valueAt(data, issue.path.slice(0, 2)) as { hosts?: unknown } | undefined
    const hosts = Array.isArray(entry?.hosts) ? entry.hosts : []
    const mapping = hosts.find(
      (host): host is Record<string, unknown> =>
        host !== null && typeof host === "object" && !Array.isArray(host),
    )
    if (mapping) {
      const [host, port] = Object.entries(mapping)[0] ?? []
      const example = host === undefined ? "api.example.com:8443" : `${host}:${String(port ?? "")}`
      return `YAML read a host:port as a key and value (because of the space after the colon); write "${example}".`
    }
  }
  return issue.message
}

function valueAt(data: unknown, path: readonly PropertyKey[]): unknown {
  let current = data
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined
    current = (current as Record<PropertyKey, unknown>)[key]
  }
  return current
}
