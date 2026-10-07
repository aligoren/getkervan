/**
 * A starting point for a tool's arguments, from its input schema: the required properties (or
 * all of them, when none is required) with a placeholder of the right type. The schema comes from
 * the server, so it is read defensively and never evaluated.
 */
export function argumentSkeleton(schema: unknown): string {
  const properties = isObject(schema) && isObject(schema.properties) ? schema.properties : {}
  const required =
    isObject(schema) && Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : []
  const names = required.length > 0 ? required : Object.keys(properties)
  const skeleton: Record<string, unknown> = {}
  for (const name of names.slice(0, 50)) skeleton[name] = placeholder(properties[name])
  return JSON.stringify(skeleton, null, 2)
}

function placeholder(schema: unknown): unknown {
  if (!isObject(schema)) return null
  if ("default" in schema) return schema.default
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0]
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type
  switch (type) {
    case "string":
      return ""
    case "number":
    case "integer":
      return 0
    case "boolean":
      return false
    case "array":
      return []
    case "object":
      return {}
    default:
      return null
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
