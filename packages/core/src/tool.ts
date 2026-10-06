import {
  type CallToolResult,
  isCallToolResult,
  type ServerContext,
  type ToolAnnotations,
} from "@modelcontextprotocol/server"
import type * as z from "zod"
import { createToolContext, type ToolContext } from "./context.js"
import { KervanDefinitionError, ToolError } from "./errors.js"
import type { Logger } from "./logger.js"

// biome-ignore lint/suspicious/noExplicitAny: matches any object schema regardless of its shape
export type AnyObjectSchema = z.ZodObject<any>

/** Input type of a tool whose definition has no `input` schema. */
export type NoInput = z.ZodObject<Record<never, never>>

export type ToolHandler<I extends AnyObjectSchema, R> = (
  input: z.output<I>,
  ctx: ToolContext,
) => R | Promise<R>

interface ToolDefinitionBase<I extends AnyObjectSchema> {
  /** Human-readable display name. */
  title?: string
  /** What the tool does and when to use it. This is the model's main guidance, so it is required. */
  description: string
  /** Arguments schema; must be a `z.object(...)`. Omit for a tool without arguments. */
  input?: I
  /** Behavior hints for clients. Untrusted by clients; they never change execution. */
  annotations?: ToolAnnotations
  /** Per-tool timeout in milliseconds; overrides `limits.toolTimeoutMs`. */
  timeoutMs?: number
}

/** A tool whose handler returns text or a full `CallToolResult`. */
export interface ToolDefinition<I extends AnyObjectSchema = AnyObjectSchema>
  extends ToolDefinitionBase<I> {
  output?: undefined
  handler: ToolHandler<I, string | CallToolResult>
}

/** A tool with an `output` schema: the handler returns that value and Kervan builds the result. */
export interface StructuredToolDefinition<
  I extends AnyObjectSchema = AnyObjectSchema,
  O extends z.ZodType = z.ZodType,
> extends ToolDefinitionBase<I> {
  output: O
  handler: ToolHandler<I, z.output<O>>
}

export type AnyToolDefinition = ToolDefinition | StructuredToolDefinition

/** A validated tool definition as stored by the app. */
export interface RegisteredToolDefinition {
  name: string
  title: string | undefined
  description: string
  input: AnyObjectSchema | undefined
  output: z.ZodType | undefined
  annotations: ToolAnnotations | undefined
  timeoutMs: number | undefined
  handler: (input: unknown, ctx: ToolContext) => unknown
}

/** Tool names per the MCP spec (SEP-986): 1-128 chars of letters, digits, `_`, `-`, `.`. */
export const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

export function validateToolDefinition(
  name: string,
  def: AnyToolDefinition,
): RegisteredToolDefinition {
  if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
    throw new KervanDefinitionError(
      "INVALID_TOOL_NAME",
      `Invalid tool name ${JSON.stringify(name)}: use 1-128 characters from A-Z, a-z, 0-9, "_", "-" and ".".`,
    )
  }
  if (typeof def?.description !== "string" || def.description.trim() === "") {
    throw new KervanDefinitionError(
      "MISSING_DESCRIPTION",
      `Tool "${name}" needs a non-empty description: it is the main guidance the model gets.`,
    )
  }
  if (def.input !== undefined && !isObjectSchema(def.input)) {
    throw new KervanDefinitionError(
      "INVALID_INPUT_SCHEMA",
      `Tool "${name}": "input" must be a Zod object schema, e.g. z.object({ city: z.string() }).`,
    )
  }
  if (def.output !== undefined && !isZodSchema(def.output)) {
    throw new KervanDefinitionError(
      "INVALID_OUTPUT_SCHEMA",
      `Tool "${name}": "output" must be a Zod schema.`,
    )
  }
  if (typeof def.handler !== "function") {
    throw new KervanDefinitionError(
      "INVALID_HANDLER",
      `Tool "${name}": "handler" must be a function.`,
    )
  }
  if (def.timeoutMs !== undefined && !isPositiveFinite(def.timeoutMs)) {
    throw new KervanDefinitionError(
      "INVALID_TIMEOUT",
      `Tool "${name}": "timeoutMs" must be a positive number of milliseconds.`,
    )
  }
  return {
    name,
    title: def.title,
    description: def.description,
    input: def.input,
    output: def.output,
    annotations: def.annotations,
    timeoutMs: def.timeoutMs,
    handler: def.handler as RegisteredToolDefinition["handler"],
  }
}

export interface InvokeOptions {
  timeoutMs: number
  logger: Logger
  protocolLogging: boolean
}

/**
 * Runs one tool call and always resolves to a `CallToolResult`. Errors are mapped so that only
 * `ToolError` messages reach the client; anything else is logged with a reference id and masked.
 */
export async function invokeTool(
  tool: RegisteredToolDefinition,
  input: unknown,
  raw: ServerContext,
  options: InvokeOptions,
): Promise<CallToolResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs)
  const signal = AbortSignal.any([raw.mcpReq.signal, timeout])
  const { ctx, close } = createToolContext(raw, {
    toolName: tool.name,
    signal,
    logger: options.logger,
    protocolLogging: options.protocolLogging,
  })
  try {
    const value = await raceAbort(
      Promise.resolve().then(() => tool.handler(input, ctx)),
      signal,
    )
    return toCallToolResult(tool, value)
  } catch (error) {
    if (timeout.aborted) {
      return errorResult(`Tool "${tool.name}" timed out after ${options.timeoutMs} ms.`)
    }
    if (raw.mcpReq.signal.aborted) {
      return errorResult(`Tool "${tool.name}" was cancelled.`)
    }
    if (error instanceof ToolError) {
      return errorResult(error.message)
    }
    const ref = crypto.randomUUID().slice(0, 8)
    options.logger.error(`Tool "${tool.name}" failed (ref: ${ref})`, error)
    return errorResult(`Internal error in tool "${tool.name}" (ref: ${ref}).`)
  } finally {
    close()
  }
}

/** Thrown when a handler returns a value Kervan cannot turn into a tool result. */
export class InvalidToolReturnError extends Error {
  override name = "InvalidToolReturnError"
}

export function toCallToolResult(tool: RegisteredToolDefinition, value: unknown): CallToolResult {
  if (tool.output !== undefined) {
    // The SDK validates structuredContent against the output schema before sending.
    return {
      content: [{ type: "text", text: JSON.stringify(value) ?? "null" }],
      structuredContent: value as CallToolResult["structuredContent"],
    }
  }
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }] }
  }
  if (isCallToolResult(value)) {
    return value
  }
  throw new InvalidToolReturnError(
    `Tool "${tool.name}" returned ${describe(value)}. Return a string or a CallToolResult ` +
      `({ content: [...] }), or declare an "output" schema to return structured data.`,
  )
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort)
        reject(error)
      },
    )
  })
}

function describe(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "an array"
  return typeof value === "object" ? "an object without a content array" : typeof value
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

interface ZodLike {
  _zod: { def: { type: string } }
}

function isZodSchema(value: unknown): value is ZodLike {
  const zod = (value as Partial<ZodLike> | null)?._zod
  return typeof zod?.def?.type === "string"
}

function isObjectSchema(value: unknown): boolean {
  return isZodSchema(value) && value._zod.def.type === "object"
}
