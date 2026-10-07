/** A problem in a spec, with its position when known (from the server's `loadSpec`). */
export interface Issue {
  path: (string | number)[]
  message: string
  severity: "error" | "warning"
  line?: number
  column?: number
}

export interface User {
  id: string
  email: string
  role: "admin" | "member"
  /** Set while the user is deactivated (only in the admin's user list). */
  disabledAt?: number | null
}

export interface Server {
  id: string
  slug: string
  name: string
  publishedVersionId: string | null
  logPayloads: boolean
  createdAt: number
  updatedAt: number
}

export interface VersionInfo {
  id: string
  serverId: string
  number: number
  sha256: string
  createdAt: number
}

export class ApiError extends Error {
  readonly status: number
  readonly issues: Issue[]

  constructor(status: number, message: string, issues: Issue[] = []) {
    super(message)
    this.status = status
    this.issues = issues
  }
}

// The CSRF token lives in memory only (never in storage): it is fetched again after a reload.
let csrfToken: string | undefined

export function setCsrfToken(token: string | undefined): void {
  csrfToken = token
}

/** Calls the management API on Studio's own origin, with the session cookie and CSRF token. */
export async function api<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
) {
  const headers: Record<string, string> = {}
  if (method !== "GET") {
    headers["content-type"] = "application/json"
    if (csrfToken) headers["x-csrf-token"] = csrfToken
  }
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers,
    ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }),
  })
  const text = await response.text()
  let data: Record<string, unknown> = {}
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    // Not JSON: keep the status.
  }
  if (!response.ok) {
    const message =
      typeof data.error === "string" ? data.error : `Request failed (${response.status})`
    throw new ApiError(response.status, message, (data.issues as Issue[] | undefined) ?? [])
  }
  return data as T
}
