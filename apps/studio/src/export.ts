import { normalizeHostPort } from "@kervan/spec-runtime"
import { isMap, isScalar, isSeq, parseDocument } from "yaml"
import type { SecretBinding } from "./secrets.js"

export class ExportError extends Error {
  override name = "ExportError"
}

/**
 * Turns a stored spec version into a kervan.yaml that runs with `kervan run`. Each declared secret
 * Studio holds gets the bindings it has in Studio: the spec's own `hosts` narrowed to the hosts
 * Studio allows. Values are never written; `kervan run` reads them from the environment.
 *
 * Only the changed `secrets` entries are rewritten, in place; the rest of the text (comments,
 * layout, line breaks) is kept byte for byte.
 */
export function exportSpec(yamlText: string, bindings: readonly SecretBinding[]): string {
  const doc = parseDocument(yamlText, { uniqueKeys: true })
  if (doc.errors.length > 0) {
    throw new ExportError("The spec has YAML errors; fix them before exporting.")
  }
  const secrets = isMap(doc.contents) ? doc.contents.get("secrets", true) : undefined
  if (secrets === undefined || secrets === null) return yamlText
  if (!isSeq(secrets)) throw new ExportError('"secrets" must be a list.')

  const byName = new Map(bindings.map((binding) => [binding.name, binding]))
  const edits: { start: number; end: number; text: string }[] = []
  const expected: { name: string; hosts?: string[] }[] = []
  secrets.items.forEach((item, index) => {
    const declared = readEntry(item)
    const range = (item as { range?: [number, number, number] }).range
    if (!declared || !range) {
      throw new ExportError(`secrets[${index}] is not a secret name or binding.`)
    }
    const binding = byName.get(declared.name)
    if (!binding) {
      expected.push(declared)
      return
    }
    // Stores keep normalized values; normalize again so a stray form can never widen anything.
    const allowed = binding.allowedHosts
      .map((host) => normalizeHostPort(host))
      .filter((host): host is string => host !== undefined)
    const hosts = declared.hosts
      ? allowed.filter((host) => declared.hosts?.includes(host))
      : allowed
    if (hosts.length === 0) {
      throw new ExportError(
        `Secret ${declared.name} is not allowed for any of the hosts the spec binds it to.`,
      )
    }
    expected.push({ name: declared.name, hosts })
    const rendered = `{ name: ${declared.name}, hosts: [${hosts.map((h) => JSON.stringify(h)).join(", ")}] }`
    // A block mapping's range ends after its line break; keep the break.
    let end = range[1]
    while (end > range[0] && /\s/.test(yamlText[end - 1] ?? "")) end--
    edits.push({ start: range[0], end, text: rendered })
  })

  let out = yamlText
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  }
  // The edit is textual, so check that the result says exactly what was intended.
  const check = parseDocument(out, { uniqueKeys: true })
  const written = isMap(check.contents) ? check.contents.get("secrets", true) : undefined
  const actual = isSeq(written) ? written.items.map(readEntry) : undefined
  if (check.errors.length > 0 || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new ExportError("Could not write the secret bindings into this spec's layout.")
  }
  return out
}

function readEntry(item: unknown): { name: string; hosts?: string[] } | undefined {
  if (isScalar(item) && typeof item.value === "string") return { name: item.value }
  if (!isMap(item)) return undefined
  const name = item.get("name")
  const hosts = item.get("hosts", true)
  if (typeof name !== "string" || !isSeq(hosts)) return undefined
  const normalized = hosts.items.map((host) =>
    isScalar(host) && typeof host.value === "string" ? normalizeHostPort(host.value) : undefined,
  )
  return {
    name,
    hosts: normalized.filter((host): host is string => host !== undefined),
  }
}
