import { STATUS_CODES } from "node:http"
import type { LookupFunction } from "node:net"
import {
  jsonSchema,
  type StructuredToolDefinition,
  type ToolContext,
  type ToolDefinition,
  ToolError,
  type ToolMiddleware,
} from "@kervan/core"
import { type HttpCall, isJsonContentType, isTextContentType, sendHttp } from "./http.js"
import type { BodyTemplate, ToolPlan } from "./plan.js"
import { SecretError, type SecretSource, type SecretVault } from "./secrets.js"
import { select } from "./select.js"
import {
  checkHeaderValue,
  encodePathValue,
  type RenderContext,
  renderText,
  resolve,
  singleRef,
} from "./template.js"

export interface RuntimeOptions {
  /** Where `{{secrets.X}}` values come from. */
  secrets: SecretSource
  /** Scrubs secret values from results, errors and logs. */
  vault: SecretVault
  /** Custom DNS lookup for outgoing requests. */
  lookup?: LookupFunction
}

export type CompiledDefinition = ToolDefinition | StructuredToolDefinition

/** Builds the `app.tool()` definition for a planned spec tool: the code API equivalent of YAML. */
export function compilePlan(plan: ToolPlan, runtime: RuntimeOptions): CompiledDefinition {
  const run = (input: unknown, ctx: ToolContext) => executePlan(plan, input, ctx, runtime)
  const base = {
    ...(plan.title === undefined ? {} : { title: plan.title }),
    description: plan.description,
    input: jsonSchema(plan.input),
    // External APIs are an open world unless the spec says otherwise.
    annotations: { openWorldHint: true, ...plan.annotations },
    // The HTTP layer has its own timeout; leave headroom for reading and selecting.
    timeoutMs: plan.limits.timeoutMs + 5_000,
    middleware: [redactMiddleware(runtime.vault)],
  }
  if (plan.output.mode === "select" && plan.output.schema) {
    return { ...base, output: jsonSchema(plan.output.schema), handler: run }
  }
  return { ...base, handler: async (input, ctx) => String(await run(input, ctx)) }
}

/** Removes secret values from results and from ToolError messages before they leave the tool. */
export function redactMiddleware(vault: SecretVault): ToolMiddleware {
  return async (_call, next) => {
    try {
      return vault.redactValue(await next())
    } catch (error) {
      if (error instanceof ToolError) throw new ToolError(vault.redact(error.message))
      throw error
    }
  }
}

async function executePlan(
  plan: ToolPlan,
  input: unknown,
  ctx: ToolContext,
  runtime: RuntimeOptions,
): Promise<unknown> {
  const secrets = await resolveSecrets(plan.secrets, runtime)
  const render: RenderContext = {
    input,
    secret: (name) => {
      const value = secrets.get(name)
      if (value === undefined) throw new ToolError(`Secret ${name} is not configured.`)
      return value
    },
  }

  const url = new URL(
    plan.origin + renderText(plan.path, render, encodePathValue) + plan.staticSearch,
  )
  for (const [name, templates] of plan.query) {
    for (const template of templates) {
      const ref = singleRef(template)
      const value = ref ? resolve(ref, render) : undefined
      if (ref && Array.isArray(value)) {
        for (const item of value) url.searchParams.append(name, scalar(item, name))
      } else if (ref && (value === undefined || value === null)) {
        // An optional input that was not given leaves the parameter out.
      } else {
        url.searchParams.append(name, renderText(template, render))
      }
    }
  }

  const headers: Record<string, string> = {}
  for (const [name, template] of plan.headers) {
    headers[name] = checkHeaderValue(renderText(template, render), name)
  }
  const has = (header: string) => Object.keys(headers).some((key) => key.toLowerCase() === header)
  let body: string | undefined
  if (plan.body) {
    body = JSON.stringify(renderBody(plan.body, render))
    if (!has("content-type")) headers["content-type"] = "application/json"
  }
  if (!has("accept")) {
    headers.accept =
      plan.output.mode === "select" ? "application/json" : "text/plain, application/json"
  }

  const call: HttpCall = {
    method: plan.method,
    url,
    headers,
    ...(body === undefined ? {} : { body }),
  }
  const response = await sendHttp(call, {
    timeoutMs: plan.limits.timeoutMs,
    maxResponseBytes: plan.limits.maxResponseBytes,
    signal: ctx.signal,
    ...(runtime.lookup ? { lookup: runtime.lookup } : {}),
  })

  if (response.status >= 400) {
    // The path may hold templated values; the vault scrubs secrets from it before logging.
    ctx.log.warning(
      runtime.vault.redact(`${plan.method} ${url.host}${url.pathname} returned ${response.status}`),
    )
    // Only the status code and its standard text: the upstream's own text is untrusted.
    const reason = STATUS_CODES[response.status]
    throw new ToolError(`Upstream returned ${response.status}${reason ? ` ${reason}` : ""}.`)
  }

  const type = mimeType(response.contentType)
  if (plan.output.mode === "raw") {
    if (!isTextContentType(response.contentType)) {
      throw new ToolError(`Upstream returned content type ${type}; raw output needs text or JSON.`)
    }
    return truncate(response.body.toString("utf8"), plan.limits.maxOutputChars)
  }

  if (!isJsonContentType(response.contentType)) {
    throw new ToolError(`Upstream returned content type ${type}; expected JSON.`)
  }
  let data: unknown
  try {
    data = JSON.parse(response.body.toString("utf8"))
  } catch {
    throw new ToolError("Upstream returned invalid JSON.")
  }
  const selected = select(data, plan.output.select) ?? null
  const text = JSON.stringify(selected)
  if (plan.output.schema) {
    if (text.length > plan.limits.maxOutputChars) {
      throw new ToolError(
        `The selected output has ${text.length} characters, more than the limit of ` +
          `${plan.limits.maxOutputChars}. Narrow output.select.`,
      )
    }
    return selected
  }
  return truncate(text, plan.limits.maxOutputChars)
}

async function resolveSecrets(names: readonly string[], runtime: RuntimeOptions) {
  const values = new Map<string, string>()
  for (const name of names) {
    const value = await runtime.secrets.get(name)
    if (value === undefined || value === "") continue
    try {
      runtime.vault.add(name, value)
    } catch (error) {
      if (error instanceof SecretError) throw new ToolError(error.message)
      throw error
    }
    values.set(name, value)
  }
  return values
}

function renderBody(node: BodyTemplate, render: RenderContext): unknown {
  switch (node.kind) {
    case "literal":
      return node.value
    case "array":
      return node.items.map((item) => renderBody(item, render))
    case "object":
      return Object.fromEntries(node.entries.map(([key, item]) => [key, renderBody(item, render)]))
    case "template": {
      // A string that is exactly one reference keeps the value's JSON type; otherwise it is text.
      const ref = singleRef(node.template)
      if (ref) {
        const value = resolve(ref, render)
        return value === undefined ? null : value
      }
      return renderText(node.template, render)
    }
  }
}

function scalar(value: unknown, name: string): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value)
  }
  throw new ToolError(
    `Every value of query parameter "${name}" must be a string, number or boolean.`,
  )
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n[truncated: ${text.length - max} more characters]`
}

/** The media type only, and only if it looks like one: upstream headers are untrusted. */
function mimeType(contentType: string): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
  return /^[a-z0-9!#$&^_.+-]{1,64}\/[a-z0-9!#$&^_.+-]{1,64}$/.test(type) ? `"${type}"` : "(unknown)"
}
