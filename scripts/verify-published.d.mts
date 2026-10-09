export interface ExpectedManifest {
  name: string
  version: string
  license: string
  engines: string | undefined
  repository: { type: string; url: string; directory: string }
}
export declare function parseArgs(
  argv: string[],
  defaultVersion: string | undefined,
): { tag: string; version: string; tarballs: string | undefined }
export declare const REGISTRY: string
export declare function same(a: unknown, b: unknown): boolean
export declare function tarballName(name: string, version: string): string
export declare function expectedManifests(
  version: string,
  readManifest: (dir: string) => Record<string, unknown> & {
    license?: string
    engines?: { node?: string }
    repository?: unknown
  },
): ExpectedManifest[]
export declare function viewProblems(
  expected: ExpectedManifest,
  viewed: unknown,
  tag: string,
): string[]
export declare function integrityProblems(
  name: string,
  bytes: Uint8Array,
  integrity: string,
): string[]
