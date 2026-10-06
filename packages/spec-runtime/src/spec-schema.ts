import * as z from "zod"

/** Limits that apply to every spec, whatever it asks for. */
export const SPEC_LIMITS = {
  maxSpecBytes: 1024 * 1024,
  maxTools: 200,
  maxSelectLength: 1000,
  minSecretLength: 8,
  maxTimeoutMs: 120_000,
  maxResponseBytes: 50 * 1024 * 1024,
  maxOutputChars: 1_000_000,
} as const

export const HTTP_DEFAULTS = {
  timeoutMs: 10_000,
  maxResponseBytes: 1024 * 1024,
  maxOutputChars: 20_000,
  allowInsecureHttp: false,
} as const

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/

const timeoutMs = z
  .number()
  .int()
  .min(100)
  .max(SPEC_LIMITS.maxTimeoutMs)
  .meta({ description: "Request timeout in milliseconds (connect and response)." })
const maxResponseBytes = z
  .number()
  .int()
  .min(1)
  .max(SPEC_LIMITS.maxResponseBytes)
  .meta({ description: "Largest response body accepted, after decompression." })
const maxOutputChars = z
  .number()
  .int()
  .min(1)
  .max(SPEC_LIMITS.maxOutputChars)
  .meta({ description: "Longest tool output sent to the model; longer output is cut." })

/** A JSON Schema object. Detailed limits (no remote $ref, complexity) are checked after parsing. */
const jsonSchemaObject = z
  .record(z.string(), z.unknown())
  .meta({ description: "A JSON Schema (draft 2020-12) object." })

const scalar = z.union([z.string(), z.number(), z.boolean()])

const httpDefaults = z
  .strictObject({
    timeoutMs: timeoutMs.optional(),
    maxResponseBytes: maxResponseBytes.optional(),
    maxOutputChars: maxOutputChars.optional(),
    allowInsecureHttp: z.boolean().optional().meta({
      description: "Allow plain http:// URLs. Off by default: secrets would travel unencrypted.",
    }),
  })
  .meta({ description: "Defaults for every tool's HTTP request." })

const httpRequest = z
  .strictObject({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    url: z.string().min(1).meta({
      description:
        "Request URL. Scheme, host and port must be literal; {{input.x}} and {{secrets.X}} may appear in the path. Put templated query parameters under `query`.",
    }),
    query: z
      .record(z.string(), z.union([scalar, z.array(scalar)]))
      .optional()
      .meta({ description: "Query parameters. Values may contain templates." }),
    headers: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional()
      .meta({ description: "Request headers. Names are literal; values may contain templates." }),
    body: z
      .unknown()
      .optional()
      .meta({ description: "JSON request body. String values may contain templates." }),
    timeoutMs: timeoutMs.optional(),
    maxResponseBytes: maxResponseBytes.optional(),
    allowInsecureHttp: z.boolean().optional(),
  })
  .meta({ description: "The HTTP request this tool makes." })

const selectOutput = z.strictObject({
  select: z.string().min(1).max(SPEC_LIMITS.maxSelectLength).meta({
    description:
      "JMESPath expression that picks and reshapes the fields the model sees, e.g. `{temp: main.temp}`. External API output is untrusted; select only what is needed.",
  }),
  schema: jsonSchemaObject.optional().meta({
    description:
      "JSON Schema of the selected value. When set, the tool returns structured content.",
  }),
  maxOutputChars: maxOutputChars.optional(),
})

const rawOutput = z.strictObject({
  raw: z.literal(true).meta({
    description:
      "Return the response body as text (cut to maxOutputChars) instead of selecting fields. Prefer `select`.",
  }),
  maxOutputChars: maxOutputChars.optional(),
})

const annotations = z.strictObject({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
})

export const specToolSchema = z.strictObject({
  name: z.string().regex(TOOL_NAME).meta({ description: "Tool name: 1-128 of A-Z a-z 0-9 _ - ." }),
  title: z.string().optional(),
  description: z
    .string()
    .min(1)
    .meta({ description: "What the tool does; the model's main guidance." }),
  input: jsonSchemaObject
    .optional()
    .meta({ description: "JSON Schema of the arguments; must have `type: object`." }),
  annotations: annotations.optional(),
  http: httpRequest,
  output: z.union([selectOutput, rawOutput]).meta({
    description: "How the response becomes the tool result: `select` (JMESPath) or `raw: true`.",
  }),
})

export const specSchema = z
  .strictObject({
    $schema: z.string().optional(),
    specVersion: z.literal(1),
    name: z.string().min(1).max(128),
    version: z.string().min(1).max(64),
    description: z.string().optional(),
    secrets: z.array(z.string().regex(SECRET_NAME)).optional().meta({
      description:
        "Secret names this spec may use as {{secrets.NAME}}. Only declared names are resolved.",
    }),
    defaults: z.strictObject({ http: httpDefaults.optional() }).optional(),
    tools: z.array(specToolSchema).min(1).max(SPEC_LIMITS.maxTools),
  })
  .meta({
    title: "Kervan spec",
    description: "A kervan.yaml file: MCP tools backed by HTTP requests.",
  })

export type Spec = z.output<typeof specSchema>
export type SpecTool = Spec["tools"][number]
export type SpecHttpRequest = SpecTool["http"]

/** The JSON Schema published for editors (VS Code YAML extension). */
export function specJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(specSchema, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >
}
