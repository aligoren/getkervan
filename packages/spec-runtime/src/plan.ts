import { checkSchemaLimits } from "./schema-limits.js"
import { checkSelect, SelectError } from "./select.js"
import { HTTP_DEFAULTS, type Spec, type SpecTool } from "./spec-schema.js"
import { parseTemplate, references, type Template, TemplateError } from "./template.js"

export type IssuePath = (string | number)[]

export interface SpecIssue {
  path: IssuePath
  message: string
  severity: "error" | "warning"
  line?: number
  column?: number
}

export type BodyTemplate =
  | { kind: "template"; template: Template }
  | { kind: "literal"; value: unknown }
  | { kind: "array"; items: BodyTemplate[] }
  | { kind: "object"; entries: [string, BodyTemplate][] }

export interface ToolPlan {
  name: string
  title: string | undefined
  description: string
  input: Record<string, unknown>
  annotations: SpecTool["annotations"]
  method: string
  /** `scheme://host:port`, never templated. */
  origin: string
  path: Template
  /** Query string written literally in the URL (no templates). */
  staticSearch: string
  query: [string, Template[]][]
  headers: [string, Template][]
  body: BodyTemplate | undefined
  secrets: string[]
  limits: {
    timeoutMs: number
    maxResponseBytes: number
    maxOutputChars: number
    followRedirects: number
    allowInsecureHttp: boolean
  }
  rateLimit: { perMinute: number; concurrency: number }
  output:
    | { mode: "select"; select: string; schema: Record<string, unknown> | undefined }
    | { mode: "raw" }
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
/** Headers the HTTP layer owns; letting a spec set them invites request smuggling. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "upgrade",
  "te",
  "trailer",
  "proxy-authorization",
  "proxy-connection",
  "accept-encoding",
])
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"])
const TOKEN = (i: number) => `__kervan_template_${i}__`
const TOKEN_PATTERN = /__kervan_template_(\d+)__/g

type Report = (path: IssuePath, message: string, severity?: "error" | "warning") => void

/**
 * Turns one validated spec tool into a request plan, reporting every problem found. Everything
 * that can be checked before a call is checked here, so calls cannot fail on spec mistakes.
 */
export function planTool(
  tool: SpecTool,
  specDefaults: Spec["defaults"] | undefined,
  declaredSecrets: ReadonlySet<string> | undefined,
  at: IssuePath,
  report: Report,
): ToolPlan | undefined {
  const defaults = specDefaults?.http
  let errors = 0
  const error: Report = (path, message, severity = "error") => {
    if (severity === "error") errors++
    report([...at, ...path], message, severity)
  }

  const input = tool.input ?? { type: "object", properties: {} }
  for (const problem of checkSchemaLimits(input)) error(["input"], problem)
  if ("schema" in tool.output && tool.output.schema) {
    for (const problem of checkSchemaLimits(tool.output.schema))
      error(["output", "schema"], problem)
  }
  if (input.type !== "object")
    error(["input", "type"], 'The input schema must have type: "object".')

  const secrets = new Set<string>()
  const checkRefs = (template: Template, path: IssuePath) => {
    for (const ref of references(template)) {
      if (ref.kind === "secret") {
        secrets.add(ref.name)
        if (declaredSecrets && !declaredSecrets.has(ref.name)) {
          error(path, `{{secrets.${ref.name}}} is not declared in the spec's "secrets" list.`)
        }
      } else if (!inputHasPath(input, ref.path)) {
        error(
          path,
          `{{input.${ref.path.join(".")}}} does not match a property of the input schema.`,
        )
      }
    }
  }
  const template = (source: string, path: IssuePath): Template | undefined => {
    try {
      const parsed = parseTemplate(source)
      checkRefs(parsed, path)
      return parsed
    } catch (cause) {
      if (cause instanceof TemplateError) error(path, cause.message)
      else throw cause
      return undefined
    }
  }

  const http = tool.http
  const allowInsecure =
    http.allowInsecureHttp ?? defaults?.allowInsecureHttp ?? HTTP_DEFAULTS.allowInsecureHttp
  // Parsing the whole URL as a template checks its syntax and references; planUrl checks its shape.
  const urlTemplate = template(http.url, ["http", "url"])
  const url =
    urlTemplate && planUrl(urlTemplate, allowInsecure, (message) => error(["http", "url"], message))

  const query: [string, Template[]][] = []
  for (const [name, value] of Object.entries(http.query ?? {})) {
    if (name.includes("{{"))
      error(["http", "query", name], "Query parameter names cannot be templated.")
    const values = Array.isArray(value) ? value : [value]
    const templates = values.map((item) => template(String(item), ["http", "query", name]))
    if (templates.every((t): t is Template => t !== undefined)) query.push([name, templates])
  }

  const headers: [string, Template][] = []
  for (const [name, value] of Object.entries(http.headers ?? {})) {
    const path = ["http", "headers", name]
    if (!HEADER_NAME.test(name)) error(path, `"${name}" is not a valid header name.`)
    else if (RESERVED_HEADERS.has(name.toLowerCase())) {
      error(path, `The "${name}" header is managed by Kervan and cannot be set.`)
    }
    const parsed = template(String(value), path)
    if (parsed) headers.push([name, parsed])
  }

  let body: BodyTemplate | undefined
  if (http.body !== undefined) {
    if (!BODY_METHODS.has(http.method))
      error(["http", "body"], `A ${http.method} request cannot have a body.`)
    body = planBody(http.body, ["http", "body"], error, template)
  }

  let output: ToolPlan["output"] = { mode: "raw" }
  if ("select" in tool.output) {
    try {
      checkSelect(tool.output.select)
    } catch (cause) {
      if (cause instanceof SelectError) error(["output", "select"], cause.message)
      else throw cause
    }
    output = { mode: "select", select: tool.output.select, schema: tool.output.schema }
  }

  if (errors > 0 || !url) return undefined
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    input,
    annotations: tool.annotations,
    method: http.method,
    origin: url.origin,
    path: url.path,
    staticSearch: url.search,
    query,
    headers,
    body,
    secrets: [...secrets],
    limits: {
      timeoutMs: http.timeoutMs ?? defaults?.timeoutMs ?? HTTP_DEFAULTS.timeoutMs,
      maxResponseBytes:
        http.maxResponseBytes ?? defaults?.maxResponseBytes ?? HTTP_DEFAULTS.maxResponseBytes,
      maxOutputChars:
        tool.output.maxOutputChars ?? defaults?.maxOutputChars ?? HTTP_DEFAULTS.maxOutputChars,
      followRedirects:
        http.followRedirects ?? defaults?.followRedirects ?? HTTP_DEFAULTS.followRedirects,
      allowInsecureHttp: allowInsecure,
    },
    rateLimit: {
      perMinute:
        tool.rateLimit?.perMinute ??
        specDefaults?.rateLimit?.perMinute ??
        HTTP_DEFAULTS.rateLimit.perMinute,
      concurrency:
        tool.rateLimit?.concurrency ??
        specDefaults?.rateLimit?.concurrency ??
        HTTP_DEFAULTS.rateLimit.concurrency,
    },
    output,
  }
}

interface PlannedUrl {
  origin: string
  search: string
  path: Template
}

/**
 * Parses the URL with each reference swapped for a token, then checks that tokens appear only in
 * the path: scheme, credentials, host and port must be literal (the first SSRF defense).
 */
function planUrl(
  parts: Template,
  allowInsecure: boolean,
  error: (message: string) => void,
): PlannedUrl | undefined {
  const refs: Template[number][] = []
  let withTokens = ""
  for (const part of parts) {
    if (part.kind === "text") withTokens += part.text
    else {
      withTokens += TOKEN(refs.length)
      refs.push(part)
    }
  }
  let url: URL
  try {
    url = new URL(withTokens)
  } catch {
    error("The URL is not a valid absolute URL.")
    return undefined
  }
  const hasToken = (value: string) => new RegExp(TOKEN_PATTERN.source).test(value)
  let ok = true
  const fail = (message: string) => {
    ok = false
    error(message)
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    fail("Only https:// URLs are supported.")
  else if (url.protocol === "http:" && !allowInsecure) {
    fail(
      "Plain http:// is not allowed (secrets would travel unencrypted). Use https:// or set " +
        "allowInsecureHttp: true.",
    )
  }
  if (url.username || url.password) {
    fail(
      "The URL must not contain credentials (user:pass@). Send them in a header using {{secrets.X}}.",
    )
  }
  if (hasToken(url.host)) fail("The URL's host and port cannot be templated.")
  if (hasToken(url.search))
    fail("Templates are not allowed in the URL's query string; use http.query.")
  if (url.hash) fail("The URL must not have a #fragment.")
  if (!ok) return undefined

  // Map the tokens in the normalized path back to their references.
  const path: Template[number][] = []
  let last = 0
  for (const match of url.pathname.matchAll(TOKEN_PATTERN)) {
    const index = match.index ?? 0
    if (index > last) path.push({ kind: "text", text: url.pathname.slice(last, index) })
    const ref = refs[Number(match[1])]
    if (ref) path.push(ref)
    last = index + match[0].length
  }
  if (last < url.pathname.length) path.push({ kind: "text", text: url.pathname.slice(last) })
  return { origin: url.origin, search: url.search, path }
}

function planBody(
  value: unknown,
  path: IssuePath,
  error: Report,
  template: (source: string, path: IssuePath) => Template | undefined,
): BodyTemplate {
  if (typeof value === "string") {
    const parsed = template(value, path)
    return parsed ? { kind: "template", template: parsed } : { kind: "literal", value }
  }
  if (Array.isArray(value)) {
    return {
      kind: "array",
      items: value.map((item, i) => planBody(item, [...path, i], error, template)),
    }
  }
  if (value !== null && typeof value === "object") {
    const entries: [string, BodyTemplate][] = []
    for (const [key, item] of Object.entries(value)) {
      if (key.includes("{{")) error([...path, key], "JSON body keys cannot be templated.")
      entries.push([key, planBody(item, [...path, key], error, template)])
    }
    return { kind: "object", entries }
  }
  return { kind: "literal", value }
}

/** Whether `input.a.b` names a property the input schema declares (deeper levels are not checked). */
function inputHasPath(schema: Record<string, unknown>, path: readonly string[]): boolean {
  let current: unknown = schema
  for (const key of path) {
    const properties = (current as { properties?: Record<string, unknown> } | undefined)?.properties
    if (!properties || typeof properties !== "object") return true
    if (!Object.hasOwn(properties, key)) return false
    current = properties[key]
  }
  return true
}
