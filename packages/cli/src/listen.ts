/**
 * One line instead of Node's stack trace when the port is taken: which port, and how to choose
 * another. Undefined for any other error.
 */
export function portInUseMessage(error: unknown, how: string): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const { code, port, address } = error as { code?: unknown; port?: unknown; address?: unknown }
  if (code !== "EADDRINUSE") return undefined
  const where = typeof address === "string" ? ` on ${address}` : ""
  return `Port ${typeof port === "number" ? port : "?"}${where} is already in use. Stop the program using it, or ${how}.`
}
