import { z } from "@kervan/core"
import { type Context, Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { addUser, listUsers, setUserDisabled, setupAdmin, verifyLogin } from "../accounts.js"
import { isSecure, type StudioConfig } from "../config.js"
import { constantTimeEqual, sha256 } from "../crypto.js"
import { listApiKeys } from "../db/repos/api-keys.js"
import { listAudit, recordAudit } from "../db/repos/audit.js"
import { getServer, listServers } from "../db/repos/servers.js"
import {
  type ActiveSession,
  createSession,
  deleteSession,
  findSession,
  SESSION_ABSOLUTE_MS,
} from "../db/repos/sessions.js"
import { anyAdminExists } from "../db/repos/users.js"
import { getVersion, listVersions } from "../db/repos/versions.js"
import { defaultWorkspace } from "../db/repos/workspaces.js"
import { ExportError } from "../export.js"
import { SecretInputError } from "../secrets.js"
import { type Studio, StudioError } from "../studio.js"
import { LoginThrottle } from "./throttle.js"

export interface ApiOptions {
  config: Pick<StudioConfig, "publicUrl">
  throttle?: LoginThrottle
  /** Called once the first admin exists (Studio may then listen beyond loopback). */
  onAdminCreated?: () => void
}

export type ApiEnv = {
  Variables: {
    clientIp: string
    session: ActiveSession | undefined
    sessionId: string | undefined
  }
}

/** Largest JSON body the API reads (a spec is at most 1 MiB, plus JSON escaping). */
export const API_MAX_BODY_BYTES = 3 * 1024 * 1024

const SAFE_METHODS = new Set(["GET", "HEAD"])

/** The CSRF token of a session: derived from its secret id, so only its holder can know it. */
export function csrfTokenFor(sessionId: string): string {
  return sha256(`kervan-csrf:${sessionId}`)
}

export function sessionCookieName(secure: boolean): string {
  return secure ? "__Host-kervan_session" : "kervan_session"
}

const credentials = z.object({ email: z.string().max(320), password: z.string().max(1024) })
const setupBody = credentials.extend({ token: z.string().max(200) })
const newServer = z.object({ slug: z.string().max(64), name: z.string().max(200) })
const newVersion = z.object({ yaml: z.string() })
const newUser = credentials.extend({ role: z.enum(["admin", "member"]) })
const secretBody = z.object({
  // Omitted when only the hosts change; never sent back.
  value: z
    .string()
    .max(16 * 1024)
    .optional(),
  allowedHosts: z.array(z.string().max(300)).max(64),
})
const deleteSecretBody = z.object({ confirm: z.boolean().optional() })
const newKey = z.object({ name: z.string().max(200) })
const settingsBody = z.object({ logPayloads: z.boolean() })
const userBody = z.object({ disabled: z.boolean() })

/**
 * The management API, mounted at `/api`. Authentication is a session cookie (HttpOnly,
 * SameSite=Lax, `__Host-` and Secure over https). Every state-changing request must come from
 * Studio's own origin (`Origin`, `Sec-Fetch-Site`), be JSON, and carry the session's CSRF token.
 * No CORS headers are ever sent.
 */
export function createApi(studio: Studio, options: ApiOptions): Hono<ApiEnv> {
  const api = new Hono<ApiEnv>()
  const db = studio.db
  const origin = options.config.publicUrl.origin
  const secure = isSecure(options.config)
  const cookieName = sessionCookieName(secure)
  const throttle = options.throttle ?? new LoginThrottle()

  api.use("*", async (c, next) => {
    await next()
    c.res.headers.set("cache-control", "no-store")
  })

  // Cross-site requests: a browser always sends Origin on these methods. Anything that is not
  // exactly Studio's origin (including "null" and a missing header) is refused before any work.
  api.use("*", async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) return next()
    if (c.req.header("origin") !== origin) {
      return c.json({ error: "Cross-origin request refused." }, 403)
    }
    const site = c.req.header("sec-fetch-site")
    if (site !== undefined && site !== "same-origin") {
      return c.json({ error: "Cross-origin request refused." }, 403)
    }
    const type = c.req.header("content-type") ?? ""
    if (!/^application\/json\s*(;|$)/i.test(type)) {
      return c.json({ error: "Send JSON (Content-Type: application/json)." }, 415)
    }
    return next()
  })

  api.use(
    "*",
    bodyLimit({
      maxSize: API_MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "The request body is too large." }, 413),
    }),
  )

  api.use("*", async (c, next) => {
    const id = getCookie(c, cookieName)
    const session = id ? findSession(db, id) : undefined
    c.set("session", session)
    c.set("sessionId", session ? id : undefined)
    return next()
  })

  /** Requires a signed-in user (and the CSRF token on state-changing requests). */
  const signedIn =
    (role?: "admin"): MiddlewareHandler<ApiEnv> =>
    async (c, next) => {
      const session = c.get("session")
      const sessionId = c.get("sessionId")
      if (!session || !sessionId) return c.json({ error: "Sign in first." }, 401)
      if (!SAFE_METHODS.has(c.req.method)) {
        const token = c.req.header("x-csrf-token") ?? ""
        if (!constantTimeEqual(token, csrfTokenFor(sessionId))) {
          return c.json({ error: "Missing or invalid CSRF token. Reload the page." }, 403)
        }
      }
      if (role === "admin" && session.user.role !== "admin") {
        return c.json({ error: "Only admins can do this." }, 403)
      }
      return next()
    }

  const startSession = (c: Context<ApiEnv>, user: { id: string; email: string; role: string }) => {
    // Never reuse an id the browser brought along (session fixation): always a new one.
    const previous = c.get("sessionId")
    if (previous) deleteSession(db, sha256(previous))
    const scope = defaultWorkspace(db)
    const session = createSession(db, scope, user.id)
    setCookie(c, cookieName, session.id, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure,
      maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000),
    })
    return {
      user: { id: user.id, email: user.email, role: user.role },
      csrfToken: csrfTokenFor(session.id),
    }
  }

  const actor = (c: Context<ApiEnv>) => ({
    type: "user" as const,
    id: c.get("session")?.user.id,
    ip: c.get("clientIp"),
  })
  const scopeOf = (c: Context<ApiEnv>) => {
    const session = c.get("session")
    if (!session) throw new StudioError("forbidden", "Sign in first.")
    return session.scope
  }

  api.get("/setup", (c) => c.json({ needed: !anyAdminExists(db) }))

  api.post("/setup", async (c) => {
    const ip = c.get("clientIp")
    const body = await parse(c, setupBody)
    const attempt = throttle.setup(ip)
    if ("retryAfter" in attempt) return tooMany(c, attempt.retryAfter)
    try {
      const { user } = await setupAdmin(db, body, ip)
      attempt.done(true)
      options.onAdminCreated?.()
      return c.json(startSession(c, user), 201)
    } catch (error) {
      // Only a wrong token counts as a failed guess.
      attempt.done(!(error instanceof StudioError && error.code === "forbidden"))
      throw error
    }
  })

  api.post("/login", async (c) => {
    const ip = c.get("clientIp")
    const body = await parse(c, credentials)
    // The attempt is reserved before the slow password check, so concurrent guesses count too.
    const attempt = throttle.login(body.email, ip)
    if ("retryAfter" in attempt) return tooMany(c, attempt.retryAfter)
    const scope = defaultWorkspace(db)
    let user: Awaited<ReturnType<typeof verifyLogin>>
    try {
      user = await verifyLogin(db, scope, body.email, body.password)
    } catch (error) {
      attempt.done(false)
      throw error
    }
    attempt.done(user !== undefined)
    if (!user) {
      recordAudit(
        db,
        scope,
        { type: "user", ip },
        {
          action: "login.failure",
          details: { email: body.email.trim().toLowerCase().slice(0, 320) },
        },
      )
      // The same answer whether or not the account exists.
      return c.json({ error: "Wrong email or password." }, 401)
    }
    const started = startSession(c, user)
    recordAudit(db, scope, { type: "user", id: user.id, ip }, { action: "login.success" })
    return c.json(started)
  })

  api.post("/logout", signedIn(), (c) => {
    const session = c.get("session")
    if (session) {
      deleteSession(db, session.idHash)
      recordAudit(db, session.scope, actor(c), { action: "logout" })
    }
    deleteCookie(c, cookieName, { path: "/", secure })
    return c.json({ ok: true })
  })

  api.get("/me", signedIn(), (c) => {
    const sessionId = c.get("sessionId") ?? ""
    return c.json({ user: c.get("session")?.user, csrfToken: csrfTokenFor(sessionId) })
  })

  api.get("/servers", signedIn(), (c) => c.json({ servers: listServers(db, scopeOf(c)) }))

  api.post("/servers", signedIn(), async (c) => {
    const body = await parse(c, newServer)
    return c.json({ server: studio.createServer(scopeOf(c), body, actor(c)) }, 201)
  })

  api.get("/servers/:id", signedIn(), (c) => {
    const scope = scopeOf(c)
    const server = getServer(db, scope, c.req.param("id"))
    if (!server) throw new StudioError("not_found", "Not found.")
    const versions = listVersions(db, scope, server.id).map(({ yamlText: _yaml, ...v }) => v)
    return c.json({ server, versions })
  })

  api.delete("/servers/:id", signedIn("admin"), async (c) => {
    await studio.deleteServer(scopeOf(c), c.req.param("id"), actor(c))
    return c.json({ ok: true })
  })

  api.post("/servers/:id/versions", signedIn(), async (c) => {
    const scope = scopeOf(c)
    const body = await parse(c, newVersion)
    const version = studio.saveVersion(scope, c.req.param("id"), body.yaml, actor(c))
    const { yamlText: _yaml, ...info } = version
    return c.json(
      { version: info, ...(await check(studio, scope, version.serverId, version.id)) },
      201,
    )
  })

  api.get("/servers/:id/versions/:vid", signedIn(), (c) => {
    const version = getVersion(db, scopeOf(c), c.req.param("id"), c.req.param("vid"))
    if (!version) throw new StudioError("not_found", "Not found.")
    return c.json({ version })
  })

  api.post("/servers/:id/versions/:vid/validate", signedIn(), async (c) =>
    c.json(await check(studio, scopeOf(c), c.req.param("id"), c.req.param("vid"))),
  )

  api.post("/servers/:id/versions/:vid/publish", signedIn(), async (c) => {
    const version = await studio.publish(
      scopeOf(c),
      c.req.param("id"),
      c.req.param("vid"),
      actor(c),
    )
    return c.json({ published: { id: version.id, number: version.number } })
  })

  api.get("/servers/:id/versions/:vid/export", signedIn(), async (c) => {
    const text = await studio.exportVersion(scopeOf(c), c.req.param("id"), c.req.param("vid"))
    return c.body(text, 200, {
      "content-type": "application/yaml; charset=utf-8",
      "content-disposition": 'attachment; filename="kervan.yaml"',
    })
  })

  api.post("/servers/:id/versions/:vid/playground", signedIn(), (c) => {
    const session = c.get("session")
    if (!session) throw new StudioError("forbidden", "Sign in first.")
    const serverId = c.req.param("id")
    const grant = studio.playgroundToken(scopeOf(c), serverId, c.req.param("vid"), {
      userId: session.user.id,
      sessionHash: session.idHash,
    })
    return c.json({ ...grant, mcpPath: `/s/${serverId}/mcp` })
  })

  // Secrets: admins only. Values go in, never out.
  api.get("/servers/:id/secrets", signedIn("admin"), async (c) =>
    c.json({ secrets: await studio.listSecrets(scopeOf(c), c.req.param("id")) }),
  )

  api.put("/servers/:id/secrets/:name", signedIn("admin"), async (c) => {
    const body = await parse(c, secretBody)
    const secret = await studio.putSecret(
      scopeOf(c),
      c.req.param("id"),
      { name: c.req.param("name"), value: body.value, allowedHosts: body.allowedHosts },
      actor(c),
    )
    return c.json({ secret })
  })

  api.delete("/servers/:id/secrets/:name", signedIn("admin"), async (c) => {
    const body = await parse(c, deleteSecretBody)
    await studio.deleteSecret(
      scopeOf(c),
      c.req.param("id"),
      c.req.param("name"),
      { confirm: body.confirm === true },
      actor(c),
    )
    return c.json({ ok: true })
  })

  // API keys: admins only. A new key is in the response once and never again.
  api.get("/servers/:id/keys", signedIn("admin"), (c) => {
    const scope = scopeOf(c)
    const serverId = c.req.param("id")
    if (!getServer(db, scope, serverId)) throw new StudioError("not_found", "Not found.")
    return c.json({ keys: listApiKeys(db, scope, serverId) })
  })

  api.post("/servers/:id/keys", signedIn("admin"), async (c) => {
    const body = await parse(c, newKey)
    const created = studio.createApiKey(scopeOf(c), c.req.param("id"), body.name, actor(c))
    return c.json({ key: created.key, info: created.info }, 201)
  })

  api.delete("/servers/:id/keys/:keyId", signedIn("admin"), (c) => {
    const scope = scopeOf(c)
    const keyId = c.req.param("keyId")
    const owned = listApiKeys(db, scope, c.req.param("id")).some((key) => key.id === keyId)
    if (!owned) throw new StudioError("not_found", "Not found.")
    studio.revokeApiKey(scope, keyId, actor(c))
    return c.json({ ok: true })
  })

  api.get("/servers/:id/versions/:from/diff/:to", signedIn(), (c) =>
    c.json(
      studio.diffVersions(scopeOf(c), c.req.param("id"), c.req.param("from"), c.req.param("to")),
    ),
  )

  api.get("/servers/:id/logs", signedIn(), (c) => {
    const admin = c.get("session")?.user.role === "admin"
    return c.json({
      calls: studio.listCalls(scopeOf(c), c.req.param("id"), { withPayloads: admin }),
    })
  })

  api.put("/servers/:id/settings", signedIn("admin"), async (c) => {
    const body = await parse(c, settingsBody)
    studio.setLogPayloads(scopeOf(c), c.req.param("id"), body.logPayloads, actor(c))
    return c.json({ ok: true })
  })

  api.get("/users", signedIn("admin"), (c) => c.json({ users: listUsers(db, scopeOf(c)) }))

  api.post("/users", signedIn("admin"), async (c) => {
    const body = await parse(c, newUser)
    return c.json({ user: await addUser(db, scopeOf(c), body, actor(c)) }, 201)
  })

  api.put("/users/:id", signedIn("admin"), async (c) => {
    const body = await parse(c, userBody)
    const user = setUserDisabled(db, scopeOf(c), c.req.param("id"), body.disabled, actor(c))
    // Their sessions are gone, so new playground requests fail; open streams end here too.
    if (body.disabled) studio.gateway.endPlayground(user.id)
    return c.json({ user })
  })

  api.get("/audit", signedIn("admin"), (c) => c.json({ events: listAudit(db, scopeOf(c)) }))

  // Mounted under Studio's app, unmatched API paths would otherwise fall through to the web UI.
  api.all("*", (c) => c.json({ error: "Not found." }, 404))

  api.onError((error, c) => {
    if (error instanceof StudioError) {
      const status = { not_found: 404, invalid: 400, conflict: 409, forbidden: 403 } as const
      return c.json(
        {
          error: error.message,
          ...(error.issues.length > 0 ? { issues: error.issues } : {}),
          ...error.details,
        },
        status[error.code],
      )
    }
    if (error instanceof SecretInputError) return c.json({ error: error.message }, 400)
    if (error instanceof ExportError) return c.json({ error: error.message }, 400)
    if (error instanceof BadRequest) return c.json({ error: error.message }, 400)
    const ref = crypto.randomUUID().slice(0, 8)
    studio.gateway.app.logger.error(`API request failed (ref: ${ref})`, error)
    return c.json({ error: `Internal error (ref: ${ref})` }, 500)
  })

  return api
}

class BadRequest extends Error {}

async function parse<T>(c: Context<ApiEnv>, schema: z.ZodType<T>): Promise<T> {
  const body = await c.req.json().catch(() => {
    throw new BadRequest("The request body is not valid JSON.")
  })
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new BadRequest("The request body does not have the expected fields.")
  return parsed.data
}

/** Validation result for the editor: errors and warnings with line and column. */
async function check(
  studio: Studio,
  scope: ActiveSession["scope"],
  serverId: string,
  versionId: string,
) {
  try {
    return { valid: true, issues: await studio.validate(scope, serverId, versionId) }
  } catch (error) {
    if (error instanceof StudioError && error.code === "invalid") {
      return { valid: false, issues: error.issues }
    }
    throw error
  }
}

function tooMany(c: Context<ApiEnv>, wait: number) {
  c.header("retry-after", String(wait))
  return c.json({ error: "Too many failed attempts. Try again later." }, 429)
}
