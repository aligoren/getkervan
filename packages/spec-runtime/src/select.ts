import { compile, type JSONValue, search } from "@jmespath-community/jmespath"
import { SPEC_LIMITS } from "./spec-schema.js"

export class SelectError extends Error {
  override name = "SelectError"
}

/**
 * Checks a JMESPath expression when the spec loads. JMESPath is an interpreted query language with
 * no code execution; Kervan registers no custom functions.
 */
export function checkSelect(expression: string): void {
  if (expression.length > SPEC_LIMITS.maxSelectLength) {
    throw new SelectError(`select is longer than ${SPEC_LIMITS.maxSelectLength} characters.`)
  }
  try {
    compile(expression)
  } catch (error) {
    throw new SelectError(`select is not a valid JMESPath expression: ${(error as Error).message}`)
  }
}

export function select(data: unknown, expression: string): unknown {
  return search(data as JSONValue, expression)
}
