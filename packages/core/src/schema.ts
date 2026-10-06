import {
  type CallToolResult,
  fromJsonSchema,
  isCallToolResult,
  type JsonSchemaType,
  type StandardSchemaWithJSON,
} from "@modelcontextprotocol/server"
import type * as z from "zod"

const JSON_SCHEMA = Symbol.for("kervan.jsonSchema")
const RAW_RESULT = Symbol.for("kervan.rawResult")

/**
 * A plain JSON Schema (2020-12) usable as a tool's `input` or `output`, for schemas that come from
 * data rather than code (another server, a spec file). Arguments are validated against it.
 */
export interface JsonSchema<T = unknown> {
  readonly [JSON_SCHEMA]: true
  readonly json: JsonSchemaType
  /** @internal The validating schema handed to the SDK. */
  readonly standard: StandardSchemaWithJSON<T, T>
}

/** Accepts any JSON Schema object, including ones typed loosely because they came from data. */
export function jsonSchema<T = Record<string, unknown>>(
  json: JsonSchemaType | Readonly<Record<string, unknown>>,
): JsonSchema<T> {
  const schema = json as JsonSchemaType
  return Object.freeze({
    [JSON_SCHEMA]: true as const,
    json: schema,
    standard: fromJsonSchema<T>(schema),
  })
}

export function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && JSON_SCHEMA in value
}

// biome-ignore lint/suspicious/noExplicitAny: matches any object schema regardless of its shape
export type AnyObjectSchema = z.ZodObject<any>

/** What a tool's `input` can be: a Zod object or an object-typed JSON Schema. */
export type InputSchema = AnyObjectSchema | JsonSchema
/** What a tool's `output` can be: any Zod schema or a JSON Schema. */
export type OutputSchema = z.ZodType | JsonSchema

export type InputOf<I extends InputSchema> =
  I extends JsonSchema<infer T> ? T : I extends AnyObjectSchema ? z.output<I> : never

export type OutputOf<O extends OutputSchema> =
  O extends JsonSchema<infer T> ? T : O extends z.ZodType ? z.output<O> : never

/** A `CallToolResult` that bypasses output wrapping, e.g. to forward another server's result. */
export interface RawResult {
  readonly [RAW_RESULT]: true
  readonly result: CallToolResult
}

/** Returns `result` unchanged from a tool with an `output` schema (content, isError and all). */
export function rawResult(result: CallToolResult): RawResult {
  return Object.freeze({ [RAW_RESULT]: true as const, result })
}

export function isRawResult(value: unknown): value is RawResult {
  return (
    typeof value === "object" &&
    value !== null &&
    RAW_RESULT in value &&
    isCallToolResult((value as RawResult).result)
  )
}
