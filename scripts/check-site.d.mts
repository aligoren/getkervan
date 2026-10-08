export declare function securityTxtFields(text: string): Map<string, string>
export declare function checkSecurityTxt(
  text: string,
  now?: number,
): { errors: string[]; warnings: string[] }
export declare function exitCode(
  result: { errors: string[]; warnings: string[] },
  strict: boolean,
): 0 | 1
export interface SiteView {
  files: Set<string>
  read(name: string): Buffer
  text(name: string): string
  size(name: string): number
}
export interface SiteParams {
  baseURL?: string
  published?: boolean
  repoURL?: string
  npmTag?: string
  [key: string]: unknown
}
export declare function siteParams(toml: string): SiteParams
export declare const NPM_PACKAGES: string[]
export declare function npmCommandProblems(code: string, params: SiteParams): string[]
export declare function registryProblems(
  params: SiteParams,
  answers: Map<string, unknown>,
): { errors: string[]; warnings: string[] }
export declare function siteView(dir: string, overrides?: Record<string, string | null>): SiteView
export declare function checkBuild(
  view: SiteView,
  params: SiteParams,
  options?: { exampleSpec?: string; exampleTs?: string; now?: number },
): { errors: string[]; warnings: string[] }
export declare function decodeEntities(text: string): string
export declare const BUDGET: Record<string, number>
export declare const STUDIO_LINE: string
export declare const REPO_PLACEHOLDER: string
