import { type App, sameEntries, type ToolRegistry } from "@kervan/core"
import {
  type CreateMcpHandlerOptions,
  createMcpHandler,
  type McpHttpHandler,
} from "@modelcontextprotocol/server"

export type RegistryHandlerOptions = Pick<
  CreateMcpHandlerOptions,
  "legacy" | "responseMode" | "maxRequestBodySize"
>

export interface RegistryHandler {
  handler: McpHttpHandler
  /** Stops following the registry and closes open requests and subscription streams. */
  dispose(): Promise<void>
}

/**
 * Serves one registry over HTTP. Each registry gets its own SDK handler, and with it its own event
 * bus, so a change in one registry never notifies subscribers of another.
 */
export function createRegistryHandler(
  app: App,
  registry: ToolRegistry,
  options: RegistryHandlerOptions = {},
): RegistryHandler {
  const handler = createMcpHandler(() => app.createServer(registry), {
    ...(options.legacy === undefined ? {} : { legacy: options.legacy }),
    ...(options.responseMode === undefined ? {} : { responseMode: options.responseMode }),
    ...(options.maxRequestBodySize === undefined
      ? {}
      : { maxRequestBodySize: options.maxRequestBodySize }),
    onerror: (error) => app.logger.debug("MCP HTTP handler reported an error", error),
  })

  // Only notify when the entries really changed (by identity), not on every onChange call.
  let last = registry.list()
  const unsubscribe = registry.onChange(() => {
    const next = registry.list()
    if (sameEntries(last, next)) return
    last = next
    handler.notify.toolsChanged()
  })

  return {
    handler,
    dispose: async () => {
      unsubscribe()
      await handler.close()
    },
  }
}

/** Creates one handler per registry on first use and reuses it for later requests. */
export class RegistryHandlers {
  readonly #app: App
  readonly #options: RegistryHandlerOptions
  // Weak: a tenant registry that is no longer referenced releases its handler too.
  readonly #byRegistry = new WeakMap<ToolRegistry, RegistryHandler>()
  readonly #all = new Set<WeakRef<RegistryHandler>>()

  constructor(app: App, options: RegistryHandlerOptions = {}) {
    this.#app = app
    this.#options = options
  }

  get(registry: ToolRegistry): McpHttpHandler {
    let entry = this.#byRegistry.get(registry)
    if (!entry) {
      entry = createRegistryHandler(this.#app, registry, this.#options)
      this.#byRegistry.set(registry, entry)
      this.#all.add(new WeakRef(entry))
    }
    return entry.handler
  }

  async closeAll(): Promise<void> {
    const entries = [...this.#all].map((ref) => ref.deref())
    this.#all.clear()
    await Promise.all(entries.map((entry) => entry?.dispose()))
  }
}
