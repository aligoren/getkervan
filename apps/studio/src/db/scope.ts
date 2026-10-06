declare const scopeBrand: unique symbol

/**
 * The workspace a query runs in. Every repository function that reads or writes workspace data
 * takes one and filters by it, so a query cannot reach another workspace's rows by id alone.
 *
 * Create it only from a verified source: the signed-in user's session, a verified API key, or the
 * single-tenant default workspace. Never from a request parameter.
 */
export interface WorkspaceScope {
  readonly workspaceId: string
  readonly [scopeBrand]: true
}

export function workspaceScope(workspaceId: string): WorkspaceScope {
  return Object.freeze({ workspaceId }) as WorkspaceScope
}
