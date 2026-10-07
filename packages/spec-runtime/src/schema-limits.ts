import { hiddenCharacter, hiddenCharacterMessage } from "./visible-text.js"

/** Limits on JSON Schemas written in a spec (input and output schemas). */
export const SCHEMA_LIMITS = {
  maxDepth: 32,
  maxNodes: 2_000,
  maxCombinators: 64,
  maxBytes: 64 * 1024,
  maxPatternLength: 512,
} as const

const DIALECT = "https://json-schema.org/draft/2020-12/schema"
const COMBINATORS = new Set(["anyOf", "oneOf", "allOf"])
/** Keywords that can load or address schemas by URI: only same-document references are allowed. */
const URI_KEYWORDS = new Set([
  "$id",
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
])

/**
 * Checks a user-written JSON Schema. Returns problems as messages; an empty list means the schema
 * may be compiled. Remote `$ref`s are refused, so no schema is ever fetched.
 */
export function checkSchemaLimits(schema: unknown): string[] {
  const problems: string[] = []
  let size: number
  try {
    size = Buffer.byteLength(JSON.stringify(schema) ?? "")
  } catch {
    return ["The schema is not plain JSON."]
  }
  if (size > SCHEMA_LIMITS.maxBytes)
    problems.push(`The schema is larger than ${SCHEMA_LIMITS.maxBytes} bytes.`)

  let nodes = 0
  let combinators = 0
  const walk = (value: unknown, depth: number, at: string) => {
    if (problems.length > 10) return
    if (Array.isArray(value)) {
      for (const [i, item] of value.entries()) walk(item, depth + 1, `${at}/${i}`)
      return
    }
    if (value === null || typeof value !== "object") return
    nodes++
    if (depth > SCHEMA_LIMITS.maxDepth) {
      problems.push(`The schema is nested deeper than ${SCHEMA_LIMITS.maxDepth} levels (at ${at}).`)
      return
    }
    for (const [key, item] of Object.entries(value)) {
      if (key === "$ref" && (typeof item !== "string" || !item.startsWith("#"))) {
        problems.push(`Only local $ref values ("#/...") are allowed (at ${at}).`)
      } else if (URI_KEYWORDS.has(key)) {
        problems.push(`"${key}" is not allowed (at ${at}).`)
      } else if (key === "$schema" && item !== DIALECT) {
        problems.push(`Only the 2020-12 dialect is supported ($schema: ${DIALECT}) (at ${at}).`)
      } else if (
        key === "pattern" &&
        typeof item === "string" &&
        item.length > SCHEMA_LIMITS.maxPatternLength
      ) {
        problems.push(
          `A pattern is longer than ${SCHEMA_LIMITS.maxPatternLength} characters (at ${at}).`,
        )
      } else if (key === "patternProperties" && item && typeof item === "object") {
        for (const pattern of Object.keys(item)) {
          if (pattern.length > SCHEMA_LIMITS.maxPatternLength) {
            problems.push(
              `A pattern is longer than ${SCHEMA_LIMITS.maxPatternLength} characters (at ${at}).`,
            )
          }
        }
      }
      // Titles and descriptions reach people and the model, like the tool's own description.
      if ((key === "title" || key === "description") && typeof item === "string") {
        const found = hiddenCharacter(item, key === "description")
        if (found) problems.push(`A ${key} ${hiddenCharacterMessage(found)} (at ${at}/${key})`)
      }
      if (COMBINATORS.has(key)) combinators++
      walk(item, depth + 1, `${at}/${key}`)
    }
  }
  walk(schema, 0, "#")
  if (nodes > SCHEMA_LIMITS.maxNodes)
    problems.push(`The schema has more than ${SCHEMA_LIMITS.maxNodes} nodes.`)
  if (combinators > SCHEMA_LIMITS.maxCombinators) {
    problems.push(
      `The schema uses more than ${SCHEMA_LIMITS.maxCombinators} anyOf/oneOf/allOf keywords.`,
    )
  }
  return problems
}
