# Public API (0.1)

Everything a package exports is listed here. **Stable** means it follows semver from 0.1 on
(breaking changes only in a new minor version while the version is 0.x, and noted in the
changelog). **Experimental** means it may change in any release. Anything not listed is
internal, even if you can reach it through a deep import.

The runtime export lists are pinned by `test/api.test.ts` in each package.

## `@kervan/core`

| Export | Kind | Status |
| --- | --- | --- |
| `createApp`, `App`, `AppOptions`, `AppLimits`, `ToolInfo`, `LiveServer` | function, types | Stable |
| `ToolDefinition`, `StructuredToolDefinition`, `ToolHandler`, `NoInput`, `AnyObjectSchema`, `InputSchema`, `OutputSchema`, `InputOf`, `OutputOf` | types | Stable |
| `ToolContext`, `ToolLogger`, `ToolLogFn`, `ToolLogLevel` | types | Stable |
| `ToolMiddleware`, `ToolCall`, `ToolCallInfo` | types | Stable |
| `ToolRegistry`, `MutableToolRegistry`, `ToolEntry`, `InMemoryToolRegistry`, `InMemoryToolRegistryOptions` | types, class | Stable |
| `ServerResolver`, `ResolveResult`, `FORBIDDEN` | types, constant | Stable |
| `ToolError`, `KervanDefinitionError`, `DefinitionErrorCode` | classes, type | Stable |
| `Logger`, `LogLevel`, `createConsoleLogger`, `ConsoleLoggerOptions`, `silentLogger` | types, functions | Stable |
| `DEFAULT_TOOL_TIMEOUT_MS`, `DEFAULT_MAX_TOOL_INPUT_ELEMENTS`, `TOOL_NAME_PATTERN` | constants | Stable |
| `z` | re-export of Zod 4 | Stable |
| `AuthInfo`, `CacheHint`, `CallToolResult`, `ContentBlock`, `ToolAnnotations` | type re-exports from the MCP SDK | Stable (they follow the SDK) |
| `jsonSchema`, `JsonSchema`, `rawResult`, `RawResult` | functions, types | **Experimental** |

## `@kervan/transport`

| Entry | Export | Status |
| --- | --- | --- |
| `@kervan/transport` | `toFetchHandler`, `FetchHandlerOptions`, `KervanHttpHandler`, `Authenticate`, `AuthInfo` | Stable |
| `@kervan/transport/node` | `serve`, `serveStdio`, `serveHttp`, `ServeOptions`, `StdioOptions`, `HttpOptions`, `HttpServerHandle`, `RateLimitOptions` | Stable |
| `@kervan/transport/testing` | `createTestClient`, `TestClientOptions` | Stable |

## `@kervan/spec-runtime`

| Export | Kind | Status |
| --- | --- | --- |
| `loadSpec`, `LoadOptions`, `LoadedSpec`, `CompiledTool`, `CompiledDefinition` | function, types | Stable |
| `applySpec` | function | Stable |
| `SpecLoadError`, `SpecIssue`, `formatIssue` | class, type, function | Stable |
| `SecretSource`, `envSecrets`, `SecretVault`, `SecretError`, `REDACTED` | type, function, classes, constant | Stable |
| `NetworkPolicy` (`allowPrivate`, `denyList`), `NetworkPolicyError` | type, class | Stable |
| `NetworkPolicy` (`resolve`, `localAddresses`, `lookupGate`), `Resolver`, `ResolvedAddress`, `LookupGate` | types, class | **Experimental** |
| `Spec`, `SpecTool`, `specJsonSchema` | types, function | Stable (the `kervan.yaml` format, `specVersion: 1`) |
| `HTTP_DEFAULTS`, `SPEC_LIMITS`, `SCHEMA_LIMITS` | constants | Stable names; values may be tuned in minor releases |
| `httpTool` | function | **Experimental** |

Internal (not exported): address classification, pinned DNS lookups, template parsing, schema
limit checks, the redaction middleware, and the Zod schema object behind `specJsonSchema`.

## `kervan` (CLI)

The command line (`kervan create`, `kervan dev`, `kervan run`) and its flags are documented in
[packages/cli/README.md](../packages/cli/README.md); flags are stable unless marked otherwise.

| Export | Kind | Status |
| --- | --- | --- |
| `run`, `RunIo` | function, type | Stable (used by `create-kervan`) |
| `createProject`, `CreateOptions`, `CreateResult`, `CreateError`, `PackageManager` | function, types, class | Stable |
| `RuntimeInfo` | type | Stable |

## `create-kervan`

A binary only (`npm create kervan`), no programmatic API.
