type JsonRpcRequest = {
  jsonrpc: "2.0"
  id: number
  method: string
  params: Record<string, unknown>
}
// biome-ignore lint/suspicious/noExplicitAny: MCP results as the server sends them
type Answer = { request: JsonRpcRequest; result: any }

export declare function specFingerprint(text: string): string
export declare function helpOf(script: string): string
export declare function cliHelp(): Record<string, string>
export declare function modernRequest(
  method: string,
  params?: Record<string, unknown>,
): JsonRpcRequest
export declare function startSpec(
  spec?: string,
): Promise<{ url: string; output(): string; stop(): Promise<void> }>
export declare function offlineAnswers(
  url: string,
): Promise<{ discover: Answer; toolsList: Answer }>
export declare function runCalculator(): string
