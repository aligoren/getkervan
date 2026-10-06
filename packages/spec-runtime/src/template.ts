import { ToolError } from "@kervan/core"

/**
 * The template language: `{{ input.a.b }}` and `{{ secrets.NAME }}`, nothing else. No logic, no
 * filters, no expressions. `\{{` writes a literal `{{`.
 */
export type TemplatePart =
  | { kind: "text"; text: string }
  | { kind: "input"; path: string[] }
  | { kind: "secret"; name: string }

export type Template = readonly TemplatePart[]

export class TemplateError extends Error {
  override name = "TemplateError"
}

const INPUT_REF = /^input((?:\.[A-Za-z_][A-Za-z0-9_]*)+)$/
const SECRET_REF = /^secrets\.([A-Z][A-Z0-9_]*)$/

export function parseTemplate(source: string): Template {
  const parts: TemplatePart[] = []
  let text = ""
  let i = 0
  while (i < source.length) {
    if (source.startsWith("\\{{", i)) {
      text += "{{"
      i += 3
      continue
    }
    if (source.startsWith("{{", i)) {
      const end = source.indexOf("}}", i + 2)
      if (end === -1) throw new TemplateError(`Unclosed "{{" in ${JSON.stringify(source)}`)
      const expression = source.slice(i + 2, end).trim()
      const input = INPUT_REF.exec(expression)
      const secret = SECRET_REF.exec(expression)
      if (!input && !secret) {
        throw new TemplateError(
          `Unsupported template {{${expression}}}: only {{input.<field>}} and {{secrets.<NAME>}} are allowed`,
        )
      }
      if (text) parts.push({ kind: "text", text })
      text = ""
      parts.push(
        input
          ? { kind: "input", path: (input[1] ?? "").slice(1).split(".") }
          : { kind: "secret", name: secret?.[1] ?? "" },
      )
      i = end + 2
      continue
    }
    text += source[i]
    i++
  }
  if (text) parts.push({ kind: "text", text })
  return parts
}

export function isTemplated(template: Template): boolean {
  return template.some((part) => part.kind !== "text")
}

/** A template that is exactly one reference, so it can keep the referenced value's type. */
export function singleRef(template: Template): Exclude<TemplatePart, { kind: "text" }> | undefined {
  const [only] = template
  return template.length === 1 && only && only.kind !== "text" ? only : undefined
}

export function* references(template: Template) {
  for (const part of template) if (part.kind !== "text") yield part
}

export interface RenderContext {
  input: unknown
  secret(name: string): string
}

/** Looks up `input.a.b`; missing values are `undefined`. */
export function lookupInput(input: unknown, path: readonly string[]): unknown {
  let value: unknown = input
  for (const key of path) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

export function resolve(
  part: Exclude<TemplatePart, { kind: "text" }>,
  ctx: RenderContext,
): unknown {
  return part.kind === "secret" ? ctx.secret(part.name) : lookupInput(ctx.input, part.path)
}

function describeRef(part: Exclude<TemplatePart, { kind: "text" }>): string {
  return part.kind === "secret" ? `secrets.${part.name}` : `input.${part.path.join(".")}`
}

/** Strings, numbers and booleans become text; anything else is an error the model can fix. */
export function scalarText(part: Exclude<TemplatePart, { kind: "text" }>, value: unknown): string {
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  if (value === undefined || value === null) {
    throw new ToolError(`Missing value for ${describeRef(part)}.`)
  }
  throw new ToolError(`${describeRef(part)} must be a string, number or boolean here.`)
}

/** Renders a template to text, passing each referenced value through `encode`. */
export function renderText(
  template: Template,
  ctx: RenderContext,
  encode: (value: string, part: Exclude<TemplatePart, { kind: "text" }>) => string = (v) => v,
): string {
  let out = ""
  for (const part of template) {
    if (part.kind === "text") out += part.text
    else out += encode(scalarText(part, resolve(part, ctx)), part)
  }
  return out
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * Path values are percent-encoded; `.`/`..`, empty values (`/a//b`, or a leading `//host`) and
 * control characters are rejected, since they change which resource the path names.
 */
export function encodePathValue(
  value: string,
  part: Exclude<TemplatePart, { kind: "text" }>,
): string {
  if (value === "" || value === "." || value === ".." || CONTROL.test(value)) {
    throw new ToolError(`${describeRef(part)} is not allowed in a URL path.`)
  }
  return encodeURIComponent(value)
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: header injection guard
const HEADER_FORBIDDEN = /[\u0000-\u0008\u000a-\u001f\u007f]/

/** Header values may not contain CR, LF, NUL or other control characters (tab is allowed). */
export function checkHeaderValue(value: string, header: string): string {
  if (HEADER_FORBIDDEN.test(value)) {
    throw new ToolError(
      `The value for header "${header}" contains a line break or control character.`,
    )
  }
  return value
}
