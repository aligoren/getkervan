/**
 * Error a tool handler throws to report a failure the model should read.
 * Its message is sent to the client verbatim, so it must not contain secrets.
 * Any other thrown error is masked (see `invokeTool`).
 */
export class ToolError extends Error {
  override name = "ToolError"
}

export type DefinitionErrorCode =
  | "INVALID_APP_OPTIONS"
  | "INVALID_TOOL_NAME"
  | "DUPLICATE_TOOL"
  | "UNKNOWN_TOOL"
  | "MISSING_DESCRIPTION"
  | "INVALID_INPUT_SCHEMA"
  | "INVALID_OUTPUT_SCHEMA"
  | "INVALID_HANDLER"
  | "INVALID_TIMEOUT"
  | "INVALID_MIDDLEWARE"

/** Thrown synchronously at definition time when an app or tool is misconfigured. */
export class KervanDefinitionError extends Error {
  override name = "KervanDefinitionError"
  readonly code: DefinitionErrorCode

  constructor(code: DefinitionErrorCode, message: string) {
    super(`[${code}] ${message}`)
    this.code = code
  }
}
