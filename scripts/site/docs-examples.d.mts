import type { SiteView } from "../check-site.mjs"

export interface CodeBlock {
  page: string
  lang: string
  check: string | undefined
  id: string | undefined
  attrs: Record<string, string>
  raw: string
}
export declare const CHECKS: Set<string>
export declare function collectBlocks(view: SiteView): CodeBlock[]
export declare function codeOf(block: CodeBlock): string
export declare function declarationProblems(blocks: CodeBlock[]): string[]
