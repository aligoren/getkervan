export interface PublishedPackage {
  dir: string
  name: string
  allow: RegExp[]
  budget: number
}
export declare const PACKAGES: PublishedPackage[]
export declare function contentProblems(
  pkg: PublishedPackage,
  files: string[],
  size: number,
): string[]
export interface MapRef {
  file: string
  map: string
}
export declare function sourceMapProblems(
  pkg: PublishedPackage,
  files: string[],
  mapRefs: MapRef[],
): string[]
export declare function orphanProblems(
  pkg: PublishedPackage,
  files: string[],
  hasSource: (file: string) => boolean,
): string[]
export declare function manifestProblems(
  pkg: PublishedPackage,
  manifest: Record<string, unknown>,
  version: string,
): string[]
export declare function readTarball(tarball: string): {
  files: string[]
  size: number
  manifest: Record<string, unknown> & { dependencies?: Record<string, string> }
  mapRefs: MapRef[]
}
export declare function run(
  command: string,
  args: string[],
  options?: import("node:child_process").SpawnSyncOptions,
): string
export declare function commandFile(app: string, pkgName: string, command: string): string
export declare function listToolsOverHttp(cwd: string, spec: string): Promise<string[]>
