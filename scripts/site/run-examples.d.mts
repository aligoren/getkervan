export declare function commandLines(code: string): string[]
export declare function words(line: string): string[]
export declare function toProcess(
  line: string,
  tree?: string,
): { env: Record<string, string>; argv: string[] }
export declare function copyWorkingTree(dest: string): void
export declare function runExamples(
  blocks: unknown[],
  options?: {
    network?: boolean
    claude?: boolean
    docker?: boolean
    published?: boolean
    log?: (line: string) => void
  },
): Promise<{ where: string; status: "ok" | "skipped" | "failed"; detail: string }[]>
