// The audit log's catalogue: every action Studio records, triggered through the real API, and
// proof that no password, secret value, API key or token ever reaches a row.
import { afterEach, describe, expect, it } from "vitest"
import { listAudit } from "../src/db/repos/audit.js"
import { type ApiStudio, apiStudio, PASSWORD } from "./api-helpers.js"
import { echoTool, spec } from "./helpers.js"

/** Every action the web API records. (`kervan-studio reset-admin` also records user.password_reset.) */
export const AUDITED_ACTIONS = [
  "studio.setup",
  "login.success",
  "login.failure",
  "logout",
  "session.end",
  "session.end_others",
  "user.create",
  "user.role",
  "user.email",
  "user.password_reset",
  "user.password_change",
  "user.profile",
  "user.theme",
  "user.disable",
  "user.enable",
  "server.create",
  "server.publish",
  "server.rollback",
  "server.publish_refused",
  "server.settings",
  "server.delete",
  "secret.create",
  "secret.rotate",
  "secret.hosts",
  "secret.delete",
  "api_key.create",
  "api_key.revoke",
].sort()

const studios: ApiStudio[] = []
afterEach(async () => {
  for (const s of studios.splice(0)) await s.close()
})

const MEMBER_PASSWORD = "member first password 1"
const TEMPORARY = "temporary password from admin 2"
const MEMBER_NEW = "member chosen password 3"
const SECRET_VALUE = "sk-live-audit-catalogue-value-0001"
const SECRET_ROTATED = "sk-live-audit-catalogue-value-0002"

describe("the audit log", () => {
  it("records every kind of change, and never a password, secret value, key or token", async () => {
    const s = apiStudio()
    studios.push(s)
    const call = (
      method: string,
      path: string,
      as?: { cookie: string; csrf: string },
      body?: unknown,
    ) =>
      s.request(method, `/api${path}`, { ...(as ?? {}), ...(body === undefined ? {} : { body }) })
    const ok = async (response: Promise<{ status: number; text: string }>) => {
      const done = await response
      expect([200, 201], done.text).toContain(done.status)
      return done as Awaited<ReturnType<ApiStudio["request"]>>
    }

    // Setup, sign-ins (one failing), users.
    const setupToken = s.setupToken()
    await ok(
      call("POST", "/setup", undefined, {
        token: setupToken,
        email: "admin@example.test",
        password: PASSWORD,
      }),
    )
    expect(
      (
        await call("POST", "/login", undefined, {
          email: "admin@example.test",
          password: "a wrong guess!!",
        })
      ).status,
    ).toBe(401)
    const admin = await s.signIn("admin@example.test")
    const created = await ok(
      call("POST", "/users", admin, {
        email: "member@example.test",
        password: MEMBER_PASSWORD,
        role: "member",
      }),
    )
    const memberId = String((created.json.user as { id: string }).id)
    await ok(
      call("PUT", `/users/${memberId}/role`, admin, { role: "admin", adminPassword: PASSWORD }),
    )
    await ok(
      call("PUT", `/users/${memberId}/role`, admin, { role: "member", adminPassword: PASSWORD }),
    )
    await ok(call("PUT", `/users/${memberId}/email`, admin, { email: "member2@example.test" }))
    await ok(
      call("POST", `/users/${memberId}/password-reset`, admin, {
        adminPassword: PASSWORD,
        password: TEMPORARY,
      }),
    )

    // The member: forced password change, profile, theme (only a real change counts), sessions.
    const member = await s.signIn("member2@example.test", TEMPORARY)
    await ok(
      call("PUT", "/profile/password", member, {
        currentPassword: TEMPORARY,
        newPassword: MEMBER_NEW,
      }),
    )
    await ok(call("PUT", "/profile", member, { displayName: "Member Two" }))
    await ok(call("PUT", "/profile/theme", member, { theme: "dark" }))
    await ok(call("PUT", "/profile/theme", member, { theme: "dark" }))
    await s.signIn("member2@example.test", MEMBER_NEW)
    await s.signIn("member2@example.test", MEMBER_NEW)
    const sessions = await ok(call("GET", "/profile/sessions", member))
    const other = (sessions.json.sessions as { ref: string; current: boolean }[]).find(
      (x) => !x.current,
    )
    await ok(call("DELETE", `/profile/sessions/${other?.ref}`, member))
    await ok(call("POST", "/profile/sessions/end-others", member, {}))

    // Servers: publish, a newer one, roll back, a refused publish, settings.
    const server = await ok(call("POST", "/servers", admin, { slug: "w", name: "W" }))
    const serverId = String((server.json.server as { id: string }).id)
    const save = async (yaml: string) =>
      String(
        (
          (await ok(call("POST", `/servers/${serverId}/versions`, admin, { yaml }))).json
            .version as { id: string }
        ).id,
      )
    const v1 = await save(spec(echoTool("https://api.example.com/one")))
    const v2 = await save(spec(echoTool("https://api.example.com/two")))
    await ok(call("POST", `/servers/${serverId}/versions/${v1}/publish`, admin, {}))
    await ok(call("POST", `/servers/${serverId}/versions/${v2}/publish`, admin, {}))
    await ok(call("POST", `/servers/${serverId}/versions/${v1}/publish`, admin, {}))
    const broken = await save("specVersion: 1\nname: x\nversion: 1\ntools: [{ name: 1 }]\n")
    expect(
      (await call("POST", `/servers/${serverId}/versions/${broken}/publish`, admin, {})).status,
    ).toBe(400)
    await ok(call("PUT", `/servers/${serverId}/settings`, admin, { logPayloads: true }))

    // Secrets: create, rotate the value, change only the hosts, delete.
    const secret = `/servers/${serverId}/secrets/API_KEY`
    await ok(call("PUT", secret, admin, { value: SECRET_VALUE, allowedHosts: ["api.example.com"] }))
    await ok(
      call("PUT", secret, admin, { value: SECRET_ROTATED, allowedHosts: ["api.example.com"] }),
    )
    await ok(call("PUT", secret, admin, { allowedHosts: ["api.example.com", "api.example.org"] }))
    await ok(call("DELETE", secret, admin, { confirm: true }))

    // API keys.
    const key = await ok(call("POST", `/servers/${serverId}/keys`, admin, { name: "ci" }))
    const keyValue = String(key.json.key)
    const keyId = String((key.json.info as { id: string }).id)
    await ok(call("DELETE", `/servers/${serverId}/keys/${keyId}`, admin))

    // Deactivate and reactivate, delete the server, sign out.
    await ok(call("PUT", `/users/${memberId}`, admin, { disabled: true }))
    await ok(call("PUT", `/users/${memberId}`, admin, { disabled: false }))
    await ok(call("DELETE", `/servers/${serverId}`, admin))
    await ok(call("POST", "/logout", admin, {}))

    const rows = listAudit(s.database.db, s.scope, { limit: 1000 })
    expect([...new Set(rows.map((row) => row.action))].sort()).toEqual(AUDITED_ACTIONS)
    // The repeated theme choice wrote nothing.
    expect(rows.filter((row) => row.action === "user.theme")).toHaveLength(1)
    expect(rows.find((row) => row.action === "user.theme")?.details).toEqual({
      from: "system",
      to: "dark",
    })

    // What the page shows (GET /api/audit) and what is stored: free of every one-time value.
    const shown = (await ok(call("GET", "/audit", await s.signIn("admin@example.test")))).text
    for (const text of [JSON.stringify(rows), shown]) {
      for (const value of [
        PASSWORD,
        "a wrong guess!!",
        MEMBER_PASSWORD,
        TEMPORARY,
        MEMBER_NEW,
        SECRET_VALUE,
        SECRET_ROTATED,
        keyValue,
        keyValue.slice(4, 24),
        setupToken,
        admin.csrf,
        admin.cookie.split("=")[1] ?? admin.cookie,
      ]) {
        expect(text, "a secret reached the audit log").not.toContain(value)
      }
    }
  })
})
