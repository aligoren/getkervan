import { STATUS_CODES } from "node:http"
import {
  jsonSchema,
  type StructuredToolDefinition,
  type ToolContext,
  type ToolDefinition,
  ToolError,
  type ToolMiddleware,
} from "@kervan/core"
import {
  type HttpCall,
  type HttpResponse,
  isJsonContentType,
  isTextContentType,
  sendHttp,
} from "./http.js"
import { type NetworkPolicy, resolveTarget } from "./network.js"
import type { BodyTemplate, ToolPlan } from "./plan.js"
import { SecretError, type SecretSource, type SecretVault, urlHostPort } from "./secrets.js"
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
  /** Which addresses requests may reach (SSRF policy). Default: public unicast only. */
  network?: NetworkPolicy
  /** Allow tools that use secrets to call plain http URLs (local development only). */
  allowSecretsOverHttp?: boolean
}

export type CompiledDefinition = ToolDefinition | StructuredToolDefinition

/** Builds the `app.tool()` definition for a planned spec tool: the code API equivalent of YAML. */
export function compilePlan(plan: ToolPlan, runtime: RuntimeOptions): CompiledDefinition {
  const limiter = new CallLimiter(plan.name, plan.rateLimit)
  const run = (input: unknown, ctx: ToolContext) =>
    limiter.run(() => executePlan(plan, input, ctx, runtime))
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
  const secrets = await resolveSecrets(plan, plan.host, runtime)
  const render: RenderContext = {
    input,
    secret: (name) => {
      const value = secrets.get(name)
      if (value === undefined) {
        throw new ToolError(`Secret ${name} is not configured for ${plan.host}.`)
      }
      return value
    },
  }

  const path = renderText(plan.path, render, encodePathValue)
  const url = new URL(plan.origin + path + plan.staticSearch)
  // Each value is checked on its own, but next to literal text it can still form a "." / ".."
  // segment (".{{input.x}}." with x = ""), which URL parsing would resolve out of the path.
  if (url.pathname !== path) {
    throw new ToolError("The input values form a dot segment, which is not allowed in a URL path.")
  }
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
  const response = await sendFollowingRedirects(call, plan, ctx, runtime, [...secrets.values()])

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
    // Redact before cutting, so a cut can never leave part of a secret behind.
    const body = response.body.toString("utf8")
    return truncate(
      redactRaw(runtime.vault, body, isJsonContentType(response.contentType)),
      plan.limits.maxOutputChars,
    )
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
  // The spec's select expression must never see a secret: it could reshape one (upper-case it,
  // reverse it, split it) or test it character by character, and the result would no longer match
  // what redaction looks for. So upstream data is redacted first, and the output again later.
  const selected = select(runtime.vault.redactValue(data), plan.output.select) ?? null
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

/**
 * Sends the request, following at most `followRedirects` redirects. Every hop is resolved and
 * checked again (scheme, credentials, addresses). When the origin changes, headers carrying
 * secrets and credentials are dropped, and a request body is never sent to another origin.
 */
async function sendFollowingRedirects(
  first: HttpCall,
  plan: ToolPlan,
  ctx: ToolContext,
  runtime: RuntimeOptions,
  secretValues: readonly string[],
): Promise<HttpResponse> {
  let call = first
  for (let hop = 0; ; hop++) {
    const timeout = AbortSignal.timeout(plan.limits.timeoutMs)
    const target = await resolveTarget(
      call.url,
      runtime.network,
      ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout,
    )
    if (call.url.protocol === "http:" && plan.secrets.length > 0 && !runtime.allowSecretsOverHttp) {
      throw new ToolError(
        `Request to ${call.url.host} was not sent: this tool uses secrets, which never travel over plain http.`,
      )
    }
    const response = await sendHttp(call, {
      timeoutMs: plan.limits.timeoutMs,
      maxResponseBytes: plan.limits.maxResponseBytes,
      signal: ctx.signal,
      target,
    })
    if (response.status < 300 || response.status >= 400) return response

    const host = call.url.host
    if (plan.limits.followRedirects === 0) {
      throw new ToolError(
        `Request to ${host} was redirected (${response.status}); redirects are not followed.`,
      )
    }
    if (hop >= plan.limits.followRedirects) {
      throw new ToolError(
        `Request to ${host} was redirected more than ${plan.limits.followRedirects} times.`,
      )
    }
    if (!response.location) {
      throw new ToolError(`Request to ${host} was redirected without a location.`)
    }
    let next: URL
    try {
      next = new URL(response.location, call.url)
    } catch {
      throw new ToolError(`Request to ${host} was redirected to an invalid location.`)
    }
    const allowed =
      next.protocol === "https:" || (next.protocol === "http:" && plan.limits.allowInsecureHttp)
    if (!allowed) throw new ToolError(`Request to ${host} was redirected to a disallowed scheme.`)
    if (next.username || next.password) {
      throw new ToolError(`Request to ${host} was redirected to a URL with credentials.`)
    }
    // Downgrading https to http would expose secrets even on the same host.
    if (call.url.protocol === "https:" && next.protocol === "http:") {
      throw new ToolError(`Request to ${host} was redirected from https to http.`)
    }

    const toGet =
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && call.method !== "GET")
    const method = toGet ? "GET" : call.method
    const body = toGet ? undefined : call.body
    const crossOrigin = next.origin !== call.url.origin
    if (crossOrigin && body !== undefined) {
      throw new ToolError(
        `Request to ${host} was redirected to another host with a request body; not followed.`,
      )
    }
    // The new URL comes from the upstream and may carry secrets it reflected from this request
    // (an open redirect). A host that may not receive every secret the tool uses is refused.
    const nextHost = urlHostPort(next)
    if (nextHost !== urlHostPort(call.url) && !(await mayReceiveSecrets(plan, nextHost, runtime))) {
      throw new ToolError(
        `Request to ${host} was redirected to a host that may not receive this tool's secrets; not followed.`,
      )
    }
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(call.headers)) {
      const lower = name.toLowerCase()
      if (toGet && lower === "content-type") continue
      // Another origin gets none of the spec's headers: any of them may carry a credential,
      // templated or written literally.
      if (crossOrigin && !CROSS_ORIGIN_HEADERS.has(lower)) continue
      if (crossOrigin && secretValues.some((secret) => value.includes(secret))) continue
      headers[name] = value
    }
    call = { method, url: next, headers, ...(body === undefined ? {} : { body }) }
  }
}

/** The only headers kept when a redirect leaves the original origin. */
const CROSS_ORIGIN_HEADERS = new Set(["accept", "user-agent"])

/** Per-tool limits on outgoing calls: a fixed one-minute window and a concurrency cap. */
class CallLimiter {
  #windowStart = 0
  #count = 0
  #active = 0
  readonly #name: string
  readonly #limits: ToolPlan["rateLimit"]

  constructor(name: string, limits: ToolPlan["rateLimit"]) {
    this.#name = name
    this.#limits = limits
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const now = Date.now()
    if (now - this.#windowStart >= 60_000) {
      this.#windowStart = now
      this.#count = 0
    }
    if (this.#count >= this.#limits.perMinute) {
      const wait = Math.ceil((this.#windowStart + 60_000 - now) / 1000)
      throw new ToolError(`Rate limit reached for tool "${this.#name}"; try again in ${wait} s.`)
    }
    if (this.#active >= this.#limits.concurrency) {
      throw new ToolError(`Too many concurrent calls to tool "${this.#name}"; try again shortly.`)
    }
    this.#count++
    this.#active++
    try {
      return await fn()
    } finally {
      this.#active--
    }
  }
}

/** Whether every secret the tool uses may be sent to `host` (spec binding and source). */
async function mayReceiveSecrets(plan: ToolPlan, host: string, runtime: RuntimeOptions) {
  for (const name of plan.secrets) {
    const hosts = plan.secretHosts.get(name)
    if (hosts && !hosts.includes(host)) return false
    const value = await runtime.secrets.get(name, { host, tool: plan.name })
    if (value === undefined || value === "") return false
  }
  return true
}

/**
 * Asks the source for each secret the tool uses, for the host it is about to be sent to. A bound
 * secret is refused here for any other host, whatever the source would return.
 */
async function resolveSecrets(plan: ToolPlan, host: string, runtime: RuntimeOptions) {
  const values = new Map<string, string>()
  for (const name of plan.secrets) {
    const hosts = plan.secretHosts.get(name)
    if (hosts && !hosts.includes(host)) {
      throw new ToolError(`Secret ${name} may not be sent to ${host}.`)
    }
    const value = await runtime.secrets.get(name, { host, tool: plan.name })
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

/**
 * Redacts a raw upstream body. JSON can spell one string many ways (`\/`, `A`), and text
 * redaction only knows a few of them, so a JSON body is also decoded and redacted value by value.
 * When that finds a secret the text missed, the redacted JSON is returned re-encoded instead of
 * the upstream's own text.
 */
function redactRaw(vault: SecretVault, body: string, json: boolean): string {
  const text = vault.redact(body)
  if (!json) return text
  let data: unknown
  try {
    data = JSON.parse(body)
  } catch {
    return text
  }
  const encoded = JSON.stringify(data)
  const redacted = JSON.stringify(vault.redactValue(data))
  return redacted === encoded ? text : vault.redact(redacted)
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
