export declare const TARBALLS: string
export declare function plan(
  target: string,
  version: string,
): { title: string; cwd: string; command: string; args: string[] }[]
export declare function main(argv: string[], cwd?: string): number
