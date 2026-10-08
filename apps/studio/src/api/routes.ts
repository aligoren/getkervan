import { z } from "@kervan/core"
import { type Context, Hono, type MiddlewareHandler } from "hono"
import { bodyLimit } from "hono/body-limit"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import {
  addUser,
  changeOwnPassword,
  checkPassword,
  listUsers,
  matchLogin,
  prepareLoginTiming,
  resetPassword,
  setTheme,
  setUserDisabled,
  setUserEmail,
  setUserRole,
  setupAdmin,
  stillLoggedIn,
  updateProfile,
  userApiKeys,
} from "../accounts.js"
import { isSecure, type StudioConfig } from "../config.js"
import { constantTimeEqual, sha256 } from "../crypto.js"
import { writeTransaction } from "../db/open.js"
import { listApiKeys } from "../db/repos/api-keys.js"
import { listAudit, recordAudit } from "../db/repos/audit.js"
import { getServer, listServers } from "../db/repos/servers.js"
import {
  type ActiveSession,
  createSession,
  deleteOtherSessions,
  deleteSession,
  deleteSessionByRef,
  findSession,
  listSessionsOf,
  SESSION_ABSOLUTE_MS,
  type SessionUser,
} from "../db/repos/sessions.js"
import { anyAdminExists, getUser, recordLogin } from "../db/repos/users.js"
import { checksOf, hasValidVersion, serverSummaries } from "../db/repos/version-checks.js"
import { getVersion, listVersions } from "../db/repos/versions.js"
import { defaultWorkspace } from "../db/repos/workspaces.js"
import { sanitizeDisplayText } from "../display-text.js"
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
const newUser = credentials.extend({
  role: z.enum(["admin", "member"]),
  adminPassword: z.string().max(1024),
})
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
const userBody = z.object({ disabled: z.boolean(), revokeKeys: z.boolean().optional() })
// Strict: a field these endpoints do not take (say, "role" on a profile) is refused, not ignored.
const profileBody = z.strictObject({ displayName: z.string().max(200).nullable() })
const passwordBody = z.strictObject({
  currentPassword: z.string().max(1024),
  newPassword: z.string().max(1024),
})
const themeBody = z.strictObject({ theme: z.enum(["system", "light", "dark"]) })
const roleBody = z.strictObject({
  role: z.enum(["admin", "member"]),
  adminPassword: z.string().max(1024),
})
const emailBody = z.strictObject({ email: z.string().max(320) })
const resetBody = z.strictObject({
  adminPassword: z.string().max(1024),
  password: z.string().max(1024).optional(),
})

/** What the web UI knows about the signed-in user. */
function publicUser(user: SessionUser) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    displayName: user.displayName,
    mustChangePassword: user.mustChangePassword,
    theme: user.theme,
  }
}

/**
 * The management API, mounted at `/api`. Authentication is a session cookie (HttpOnly,
 * SameSite=Lax, `__Host-` and Secure over https). Every state-changing request must come from
 * Studio's own origin (`Origin`, `Sec-Fetch-Site`), be JSON, and carry the session's CSRF token.
 * No CORS headers are ever sent.
 */
export function createApi(studio: Studio, options: ApiOptions): Hono<ApiEnv> {
  const api = new Hono<ApiEnv>()
  const db = studio.db
  // Ready before the first sign-in, so an unknown email is not slower than a known one even once.
  void prepareLoginTiming()
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

  /**
   * Requires a signed-in user (and the CSRF token on state-changing requests). A user whose
   * password an admin reset may only reach the endpoints marked `duringPasswordChange` until they
   * choose a new one: hiding the rest in the UI would not be enough.
   */
  const signedIn =
    (role?: "admin", options: { duringPasswordChange?: boolean } = {}): MiddlewareHandler<ApiEnv> =>
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
      if (session.user.mustChangePassword && !options.duringPasswordChange) {
        return c.json(
          { error: "Choose a new password first.", code: "password_change_required" },
          403,
        )
      }
      if (role === "admin" && session.user.role !== "admin") {
        return c.json({ error: "Only admins can do this." }, 403)
      }
      return next()
    }
  const duringPasswordChange = { duringPasswordChange: true }

  const startSession = (c: Context<ApiEnv>, user: SessionUser) => {
    // Never reuse an id the browser brought along (session fixation): always a new one.
    const previous = c.get("sessionId")
    if (previous) deleteSession(db, sha256(previous))
    const scope = defaultWorkspace(db)
    const session = createSession(db, scope, user.id, Date.now(), {
      ip: c.get("clientIp"),
      userAgent: c.req.header("user-agent"),
    })
    setCookie(c, cookieName, session.id, {
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure,
      maxAge: Math.floor(SESSION_ABSOLUTE_MS / 1000),
    })
    return { user: publicUser(user), csrfToken: csrfTokenFor(session.id) }
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
      const { scope, user } = await setupAdmin(db, body, ip)
      attempt.done(true)
      // Setup signs the first admin in: that is their first login.
      recordLogin(db, scope, user.id)
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
    let match: Awaited<ReturnType<typeof matchLogin>>
    try {
      match = await matchLogin(db, scope, body.email, body.password)
    } catch (error) {
      attempt.done(false)
      throw error
    }
    // Read again after the slow check, and the session started in the same transaction: a
    // password changed or reset, or a user deactivated, meanwhile gets no session.
    const signedInAs = writeTransaction(db, (tx) => {
      const user = match && stillLoggedIn(tx, scope, match)
      return user && { user, started: startSession(c, user) }
    })
    attempt.done(signedInAs !== undefined)
    if (!signedInAs) {
      recordAudit(
        db,
        scope,
        { type: "user", ip },
        {
          action: "login.failure",
          // Kept for the record, but shown so that it cannot mislead (display-text.ts).
          details: { email: sanitizeDisplayText(body.email.trim().toLowerCase(), 320) },
        },
      )
      // The same answer whether or not the account exists.
      return c.json({ error: "Wrong email or password." }, 401)
    }
    const { user, started } = signedInAs
    recordLogin(db, scope, user.id)
    recordAudit(db, scope, { type: "user", id: user.id, ip }, { action: "login.success" })
    return c.json(started)
  })

  // The web UI's first request: who is signed in, if anyone. No session is an answer, not an
  // error, so it is a 200 (the browser does not log it as a failed request).
  api.get("/session", (c) => {
    const session = c.get("session")
    const sessionId = c.get("sessionId")
    if (!session || !sessionId) return c.json({ user: null, setupNeeded: !anyAdminExists(db) })
    return c.json({ user: publicUser(session.user), csrfToken: csrfTokenFor(sessionId) })
  })

  api.post("/logout", signedIn(undefined, duringPasswordChange), (c) => {
    const session = c.get("session")
    if (session) {
      deleteSession(db, session.idHash)
      recordAudit(db, session.scope, actor(c), { action: "logout" })
    }
    deleteCookie(c, cookieName, { path: "/", secure })
    return c.json({ ok: true })
  })

  api.get("/me", signedIn(undefined, duringPasswordChange), (c) => {
    const sessionId = c.get("sessionId") ?? ""
    const session = c.get("session")
    return c.json({
      user: session ? publicUser(session.user) : undefined,
      csrfToken: csrfTokenFor(sessionId),
    })
  })

  // Profile: the signed-in user's own account. Members reach only their own; there is no id.
  api.get("/profile", signedIn(undefined, duringPasswordChange), (c) => {
    const session = c.get("session")
    const user = session && getUser(db, session.scope, session.user.id)
    if (!user) throw new StudioError("not_found", "Not found.")
    return c.json({ user })
  })

  api.put("/profile", signedIn(), async (c) => {
    const body = await parse(c, profileBody)
    const session = c.get("session")
    if (!session) throw new StudioError("forbidden", "Sign in first.")
    return c.json({ user: updateProfile(db, session.scope, session.user.id, body, actor(c)) })
  })

  // The UI theme follows the user across devices. No user id: only one's own can change.
  api.put("/profile/theme", signedIn(), async (c) => {
    const body = await parse(c, themeBody)
    const session = c.get("session")
    if (!session) throw new StudioError("forbidden", "Sign in first.")
    return c.json({ theme: setTheme(db, session.scope, session.user.id, body.theme, actor(c)) })
  })

  api.put("/profile/password", signedIn(undefined, duringPasswordChange), async (c) => {
    const body = await parse(c, passwordBody)
    const session = c.get("session")
    if (!session) throw new StudioError("forbidden", "Sign in first.")
    // A wrong current password counts like a failed login for this account and IP.
    const attempt = throttle.login(session.user.email, c.get("clientIp"))
    if ("retryAfter" in attempt) return tooMany(c, attempt.retryAfter)
    let result: { sessionsEnded: number }
    try {
      result = await changeOwnPassword(
        db,
        session.scope,
        session.user.id,
        body,
        session.idHash,
        actor(c),
      )
    } catch (error) {
      attempt.done(!(error instanceof StudioError && error.code === "forbidden"))
      throw error
    }
    attempt.done(true)
    // Other sessions are gone, so their playground tokens are too; open streams end here.
    studio.gateway.endPlayground(session.user.id)
    // This session continues under a new id (and so a new CSRF token): a copy of the old cookie,
    // say one taken before the change, no longer works.
    const user = getUser(db, session.scope, session.user.id)
    if (!user) throw new StudioError("not_found", "Not found.")
    const { csrfToken } = startSession(c, user)
    return c.json({ ...result, csrfToken })
  })

  api.get("/profile/sessions", signedIn(), (c) => {
    const session = c.get("session")
    if (!session) throw new StudioError("forbidden", "Sign in first.")
    return c.json({
      sessions: listSessionsOf(db, session.scope, session.user.id, session.idHash),
    })
  })

  api.delete("/profile/sessions/:ref", signedIn(), (c) => {
    const session = c.get("session")
    if (!session) throw new StudioError("forbidden", "Sign in first.")
    if (!deleteSessionByRef(db, session.scope, session.user.id, c.req.param("ref"))) {
      throw new StudioError("not_found", "Not found.")
    }
    recordAudit(db, session.scope, actor(c), {
      action: "session.end",
      target: { type: "user", id: session.user.id },
    })
    return c.json({ ok: true })
  })

  api.post("/profile/sessions/end-others", signedIn(), (c) => {
    const session = c.get("session")
    if (!session) throw new StudioError("forbidden", "Sign in first.")
    const ended = deleteOtherSessions(db, session.scope, session.user.id, session.idHash)
    recordAudit(db, session.scope, actor(c), {
      action: "session.end_others",
      target: { type: "user", id: session.user.id },
      details: { sessionsEnded: ended },
    })
    return c.json({ sessionsEnded: ended })
  })

  api.get("/servers", signedIn(), (c) => {
    const scope = scopeOf(c)
    const summaries = serverSummaries(db, scope)
    return c.json({
      servers: listServers(db, scope).map((server) => ({
        ...server,
        summary: summaries.get(server.id) ?? null,
      })),
    })
  })

  api.post("/servers", signedIn(), async (c) => {
    const body = await parse(c, newServer)
    return c.json({ server: studio.createServer(scopeOf(c), body, actor(c)) }, 201)
  })

  api.get("/servers/:id", signedIn(), (c) => {
    const scope = scopeOf(c)
    const server = getServer(db, scope, c.req.param("id"))
    if (!server) throw new StudioError("not_found", "Not found.")
    const listed = listVersions(db, scope, server.id)
    const checks = checksOf(
      db,
      scope,
      listed.map((v) => v.id),
    )
    const versions = listed.map(({ yamlText: _yaml, ...v }) => ({
      ...v,
      check: checks.get(v.id) ?? null,
    }))
    // The same status the server list shows (published version, newest draft, last call).
    const summary = serverSummaries(db, scope).get(server.id) ?? null
    return c.json({ server: { ...server, summary }, versions })
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

  // Disabling and enabling follow the publishing rules: any signed-in user, with CSRF.
  api.post("/servers/:id/disable", signedIn(), async (c) => {
    const server = await studio.setServerDisabled(scopeOf(c), c.req.param("id"), true, actor(c))
    return c.json({ server })
  })

  api.post("/servers/:id/enable", signedIn(), async (c) => {
    const server = await studio.setServerDisabled(scopeOf(c), c.req.param("id"), false, actor(c))
    return c.json({ server })
  })

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

  // What a new server still needs (the "next steps" checklist). Counts of secrets and keys are
  // for admins, who manage them.
  api.get("/servers/:id/overview", signedIn(), async (c) => {
    const scope = scopeOf(c)
    const server = getServer(db, scope, c.req.param("id"))
    if (!server) throw new StudioError("not_found", "Not found.")
    const summary = serverSummaries(db, scope).get(server.id) ?? null
    const admin = c.get("session")?.user.role === "admin"
    const keys = admin ? listApiKeys(db, scope, server.id) : []
    const published = server.publishedVersionId
      ? (checksOf(db, scope, [server.publishedVersionId]).get(server.publishedVersionId) ?? null)
      : null
    return c.json({
      summary,
      anyValid: hasValidVersion(db, scope, server.id),
      // How many secrets the published version uses (null: nothing published or not checked).
      publishedSecrets: published ? published.secrets : null,
      ...(admin
        ? {
            secrets: (await studio.listSecrets(scope, server.id)).length,
            activeKeys: keys.filter((k) => k.revokedAt === null).length,
            keyUsed: keys.some((k) => k.lastUsedAt !== null),
          }
        : {}),
    })
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

  /**
   * Sensitive admin actions (adding a user, a password reset, a role change) need the admin's own
   * password, checked here on the server and throttled like a login: a stolen session alone is
   * not enough.
   * Returns a response to send instead (429, 403) or `undefined` when confirmed.
   */
  const confirmAdmin = async (c: Context<ApiEnv>, password: string) => {
    const session = c.get("session")
    if (!session) throw new StudioError("forbidden", "Sign in first.")
    const attempt = throttle.login(session.user.email, c.get("clientIp"))
    if ("retryAfter" in attempt) return tooMany(c, attempt.retryAfter)
    const confirmed = await checkPassword(db, session.scope, session.user.id, password)
    attempt.done(confirmed)
    if (!confirmed) throw new StudioError("forbidden", "Your password is wrong.")
    return undefined
  }

  api.post("/users", signedIn("admin"), async (c) => {
    const { adminPassword, ...input } = await parse(c, newUser)
    // A new account (above all an admin one) is a lasting way in: the session alone is not enough.
    const refused = await confirmAdmin(c, adminPassword)
    if (refused) return refused
    return c.json({ user: await addUser(db, scopeOf(c), input, actor(c)) }, 201)
  })

  api.get("/users/:id/keys", signedIn("admin"), (c) =>
    c.json({ keys: userApiKeys(db, scopeOf(c), c.req.param("id")) }),
  )

  api.put("/users/:id", signedIn("admin"), async (c) => {
    const body = await parse(c, userBody)
    const { user, revokedKeys } = setUserDisabled(
      db,
      scopeOf(c),
      c.req.param("id"),
      body.disabled,
      actor(c),
      { revokeKeys: body.revokeKeys === true },
    )
    // Their sessions are gone, so new playground requests fail; open streams end here too.
    if (body.disabled) studio.gateway.endPlayground(user.id)
    for (const keyId of revokedKeys) studio.gateway.disconnect({ keyId })
    return c.json({ user, revokedKeys: revokedKeys.length })
  })

  api.put("/users/:id/role", signedIn("admin"), async (c) => {
    const body = await parse(c, roleBody)
    const refused = await confirmAdmin(c, body.adminPassword)
    if (refused) return refused
    const before = getUser(db, scopeOf(c), c.req.param("id"))
    const user = setUserRole(db, scopeOf(c), c.req.param("id"), body.role, actor(c))
    // Their sessions ended with the change; their open playground streams end here.
    if (before?.role !== user.role) studio.gateway.endPlayground(user.id)
    return c.json({ user })
  })

  api.put("/users/:id/email", signedIn("admin"), async (c) => {
    const body = await parse(c, emailBody)
    return c.json({ user: setUserEmail(db, scopeOf(c), c.req.param("id"), body.email, actor(c)) })
  })

  api.post("/users/:id/password-reset", signedIn("admin"), async (c) => {
    const body = await parse(c, resetBody)
    const session = c.get("session")
    if (!session) throw new StudioError("forbidden", "Sign in first.")
    const refused = await confirmAdmin(c, body.adminPassword)
    if (refused) return refused
    const userId = c.req.param("id")
    const result = await resetPassword(
      db,
      session.scope,
      userId,
      { password: body.password },
      actor(c),
    )
    studio.gateway.endPlayground(userId)
    return c.json(result)
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
