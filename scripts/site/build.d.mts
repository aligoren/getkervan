export declare function pinnedHugoVersion(): string
export declare function parseHugoVersion(output: string): string | undefined
export declare function installHint(version: string): string
export declare function hugoProblem(
  versionOutput: string | undefined,
  pinned: string,
): string | undefined
