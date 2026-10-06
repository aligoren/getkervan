import type { AuthInfo } from "@modelcontextprotocol/server"
import type * as z from "zod"
import { KervanDefinitionError } from "./errors.js"
import {
  type AnyObjectSchema,
  type AnyToolDefinition,
  type NoInput,
  type RegisteredToolDefinition,
  type StructuredToolDefinition,
  type ToolDefinition,
  validateToolDefinition,
} from "./tool.js"

/** A validated, frozen tool definition. Registries return the same object until the tool changes. */
export type ToolEntry = Readonly<RegisteredToolDefinition>

/**
 * The read side of a tool set: all a transport needs to serve it.
 *
 * Identity contract: `list()` returns the same entry objects for tools that did not change, so
 * consumers can detect real changes by identity and avoid spurious `list_changed` notifications.
 * Shared (multi-instance) implementations fire `onChange` for changes made on any instance.
 */
export interface ToolRegistry {
  /** Current tools in a deterministic order. */
  list(): readonly ToolEntry[]
  /** Called after the tool set may have changed. Returns an idempotent unsubscribe function. */
  onChange(listener: () => void): () => void
}

/** A registry that can be changed at runtime. */
export interface MutableToolRegistry extends ToolRegistry {
  /** Adds a tool at the end. Throws `KervanDefinitionError` if it is invalid or the name is taken. */
  add<I extends AnyObjectSchema = NoInput>(name: string, definition: ToolDefinition<I>): void
  add<I extends AnyObjectSchema = NoInput, O extends z.ZodType = z.ZodType>(
    name: string,
    definition: StructuredToolDefinition<I, O>,
  ): void
  /** Replaces an existing tool, keeping its position. Throws if the tool does not exist. */
  replace<I extends AnyObjectSchema = NoInput>(name: string, definition: ToolDefinition<I>): void
  replace<I extends AnyObjectSchema = NoInput, O extends z.ZodType = z.ZodType>(
    name: string,
    definition: StructuredToolDefinition<I, O>,
  ): void
  /** Removes a tool. Returns `false` if it did not exist. */
  remove(name: string): boolean
  has(name: string): boolean
}

export interface InMemoryToolRegistryOptions {
  /** Receives errors thrown by change listeners. Default: `console.error`. */
  onListenerError?: (error: unknown) => void
}

/**
 * Process-local registry. Change notifications are coalesced per microtask, so several changes
 * made in one synchronous block produce one `onChange` call.
 */
export class InMemoryToolRegistry implements MutableToolRegistry {
  readonly #entries = new Map<string, ToolEntry>()
  readonly #listeners = new Set<() => void>()
  readonly #onListenerError: (error: unknown) => void
  #snapshot: readonly ToolEntry[] | undefined
  #pending = false

  constructor(options: InMemoryToolRegistryOptions = {}) {
    this.#onListenerError =
      options.onListenerError ??
      ((error) => console.error("[kervan] error: tool registry listener failed", error))
  }

  list(): readonly ToolEntry[] {
    this.#snapshot ??= Object.freeze([...this.#entries.values()])
    return this.#snapshot
  }

  has(name: string): boolean {
    return this.#entries.has(name)
  }

  add(name: string, definition: AnyToolDefinition): void {
    const entry = Object.freeze(validateToolDefinition(name, definition))
    if (this.#entries.has(name)) {
      throw new KervanDefinitionError(
        "DUPLICATE_TOOL",
        `A tool named "${name}" is already registered.`,
      )
    }
    this.#entries.set(name, entry)
    this.#changed()
  }

  replace(name: string, definition: AnyToolDefinition): void {
    const entry = Object.freeze(validateToolDefinition(name, definition))
    if (!this.#entries.has(name)) {
      throw new KervanDefinitionError(
        "UNKNOWN_TOOL",
        `There is no tool named "${name}" to replace.`,
      )
    }
    this.#entries.set(name, entry)
    this.#changed()
  }

  remove(name: string): boolean {
    const removed = this.#entries.delete(name)
    if (removed) this.#changed()
    return removed
  }

  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #changed(): void {
    this.#snapshot = undefined
    if (this.#pending) return
    this.#pending = true
    queueMicrotask(() => {
      this.#pending = false
      for (const listener of [...this.#listeners]) {
        try {
          listener()
        } catch (error) {
          this.#onListenerError(error)
        }
      }
    })
  }
}

/** True when two lists hold the same entry objects in the same order. */
export function sameEntries(a: readonly ToolEntry[], b: readonly ToolEntry[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry === b[i])
}

/** Returned by a `ServerResolver` to deny a request (HTTP 403). */
export const FORBIDDEN: unique symbol = Symbol.for("kervan.forbidden")

/**
 * Picks the tool set that serves an HTTP request. Runs after authentication; derive the tenant
 * from `auth` (verified), not from client-controlled headers alone. Return the same registry
 * object for the same tenant. `null`/`undefined` → 404, `FORBIDDEN` → 403.
 */
export type ServerResolver = (
  request: Request,
  context: { auth: AuthInfo | undefined },
) => ResolveResult | Promise<ResolveResult>

export type ResolveResult = ToolRegistry | typeof FORBIDDEN | null | undefined
