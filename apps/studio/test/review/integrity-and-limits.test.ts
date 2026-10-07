// Security review (phase 4a): database integrity triggers (T13, T14), setup tokens (T9), the Host
// header check and the per-IP limit key (T12). Every test asserts the secure behavior.
import { request as httpRequest } from "node:http"
import type { AddressInfo } from "node:net"
import { serve } from "@hono/node-server"
import { afterEach, describe, expect, it } from "vitest"
import { clientIp, rateLimitKey } from "../../src/client-ip.js"
import { allowedHostNames } from "../../src/config.js"
import { openDatabase } from "../../src/db/open.js"
import { listAudit, recordAudit } from "../../src/db/repos/audit.js"
import { createServer } from "../../src/db/repos/servers.js"
import {
  consumeSetupToken,
  issueSetupToken,
  SETUP_TOKEN_TTL_MS,
} from "../../src/db/repos/tokens.js"
import { getVersion, saveVersion } from "../../src/db/repos/versions.js"
import { createWorkspace } from "../../src/db/repos/workspaces.js"
import { createStudioHttp } from "../../src/http.js"
import { InMemorySecretStore } from "../../src/secrets.js"
import { Studio } from "../../src/studio.js"
import { recordingLogger, TEST_ONLY_NETWORK } from "../helpers.js"

const closers: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
})

function database() {
  const opened = openDatabase(":memory:")
  closers.push(() => opened.close())
  const scope = createWorkspace(opened.db, "w")
  const server = createServer(opened.db, scope, { slug: "s", name: "S" })
  return { ...opened, scope, server }
}

describe("review: spec versions cannot change once saved", () => {
  it("refuses UPDATE (baseline)", () => {
    const d = database()
    const v = saveVersion(d.db, d.scope, d.server.id, "original", null)
    expect(() =>
      d.sqlite.prepare("UPDATE spec_versions SET yaml_text = 'x' WHERE id = ?").run(v?.id),
    ).toThrow(/immutable/)
  })

  it("refuses INSERT OR REPLACE over an existing version id", () => {
    const d = database()
    const v = saveVersion(d.db, d.scope, d.server.id, "original", null)
    try {
      d.sqlite
        .prepare(
          `INSERT OR REPLACE INTO spec_versions
             (id, workspace_id, server_id, number, yaml_text, sha256, created_by, created_at)
           VALUES (?, ?, ?, ?, 'tampered', 'x', NULL, 0)`,
        )
        .run(v?.id, d.scope.workspaceId, d.server.id, v?.number)
    } catch {
      // refused: fine
    }
    expect(getVersion(d.db, d.scope, d.server.id, v?.id ?? "")?.yamlText).toBe("original")
  })

  it("refuses deleting a version and re-inserting different text under its id", () => {
    const d = database()
    const v = saveVersion(d.db, d.scope, d.server.id, "original", null)
    try {
      d.sqlite.prepare("DELETE FROM spec_versions WHERE id = ?").run(v?.id)
      d.sqlite
        .prepare(
          `INSERT INTO spec_versions
             (id, workspace_id, server_id, number, yaml_text, sha256, created_by, created_at)
           VALUES (?, ?, ?, ?, 'tampered', 'x', NULL, 0)`,
        )
        .run(v?.id, d.scope.workspaceId, d.server.id, v?.number)
    } catch {
      // refused: fine
    }
    expect(getVersion(d.db, d.scope, d.server.id, v?.id ?? "")?.yamlText).toBe("original")
  })

  it("still deletes a server's versions with the server (cascade)", () => {
    const d = database()
    saveVersion(d.db, d.scope, d.server.id, "original", null)
    d.sqlite.prepare("DELETE FROM servers WHERE id = ?").run(d.server.id)
    expect(d.sqlite.prepare("SELECT count(*) AS n FROM spec_versions").get()).toEqual({ n: 0 })
  })
})

describe("review: the audit log is append-only", () => {
  const audit = (d: ReturnType<typeof database>) => {
    recordAudit(d.db, d.scope, { type: "cli" }, { action: "server.delete" })
    const [event] = listAudit(d.db, d.scope)
    return event
  }

  it.each([
    ["UPDATE", "UPDATE audit_events SET action = 'nothing' WHERE id = ?"],
    ["DELETE", "DELETE FROM audit_events WHERE id = ?"],
  ])("refuses %s (baseline)", (_name, sql) => {
    const d = database()
    const event = audit(d)
    expect(() => d.sqlite.prepare(sql).run(event?.id)).toThrow(/append-only/)
  })

  it("refuses an UPSERT that rewrites an event", () => {
    const d = database()
    const event = audit(d)
    expect(() =>
      d.sqlite
        .prepare(
          `INSERT INTO audit_events (id, workspace_id, at, actor_type, action) VALUES (?, ?, 0, 'cli', 'x')
           ON CONFLICT(id) DO UPDATE SET action = 'nothing'`,
        )
        .run(event?.id, d.scope.workspaceId),
    ).toThrow(/append-only/)
  })

  it("refuses INSERT OR REPLACE over an existing event", () => {
    const d = database()
    const event = audit(d)
    try {
      d.sqlite
        .prepare(
          `INSERT OR REPLACE INTO audit_events (id, workspace_id, at, actor_type, action)
           VALUES (?, ?, 0, 'cli', 'nothing happened')`,
        )
        .run(event?.id, d.scope.workspaceId)
    } catch {
      // refused: fine
    }
    expect(listAudit(d.db, d.scope)[0]?.action).toBe("server.delete")
  })
})

describe("review: setup tokens (T9)", () => {
  it("are single use, even when presented twice at once", () => {
    const d = database()
    const { token } = issueSetupToken(d.db)
    const results = [consumeSetupToken(d.db, token), consumeSetupToken(d.db, token)]
    expect(results).toEqual([true, false])
  })

  it("expire exactly at their expiry time", () => {
    const d = database()
    const now = 1_000_000
    const { token } = issueSetupToken(d.db, now)
    expect(consumeSetupToken(d.db, token, now + SETUP_TOKEN_TTL_MS)).toBe(false)
  })

  it("are invalidated by a new token, even unused", () => {
    const d = database()
    const first = issueSetupToken(d.db).token
    const second = issueSetupToken(d.db).token
    expect(consumeSetupToken(d.db, first)).toBe(false)
    expect(consumeSetupToken(d.db, second)).toBe(true)
  })

  it("are stored only as a hash", () => {
    const d = database()
    const { token } = issueSetupToken(d.db)
    const dump = JSON.stringify(d.sqlite.prepare("SELECT * FROM one_time_tokens").all())
    expect(dump).not.toContain(token)
  })
})

describe("review: Host header (DNS rebinding)", () => {
  async function studioHttp(publicUrl: string) {
    const opened = openDatabase(":memory:")
    const studio = new Studio({
      db: opened.db,
      secrets: new InMemorySecretStore(),
      network: TEST_ONLY_NETWORK,
      allowedHosts: allowedHostNames({ publicUrl: new URL(publicUrl) }),
      allowedOrigins: [new URL(publicUrl).origin],
      logger: recordingLogger(),
    })
    const http = createStudioHttp(studio, { publicUrl: new URL(publicUrl), trustProxy: 0 })
    const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
      const s = serve({ fetch: http.fetch, port: 0, hostname: "127.0.0.1" }, () => resolve(s))
    })
    closers.push(async () => {
      await studio.close()
      await new Promise<void>((done) => {
        server.close(() => done())
        if ("closeAllConnections" in server) server.closeAllConnections()
      })
      opened.close()
    })
    return (server.address() as AddressInfo).port
  }

  function status(port: number, host: string | undefined): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/s/x/mcp",
          method: "POST",
          setHost: host !== undefined,
          headers: host === undefined ? {} : { host },
        },
        (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        },
      )
      req.on("error", reject)
      req.end("{}")
    })
  }

  it("accepts only the public host name, in any case and with any port", async () => {
    const port = await studioHttp("https://studio.example.test")
    expect(await status(port, "studio.example.test")).not.toBe(403)
    expect(await status(port, "STUDIO.example.TEST:443")).not.toBe(403)
    for (const bad of [
      "studio.example.test.",
      "studio.example.test.attacker.test",
      "attacker.test",
      "127.0.0.1",
      "localhost",
      "[::1]",
      "studio.example.test:443, attacker.test",
      "",
    ]) {
      expect([400, 403], JSON.stringify(bad)).toContain(await status(port, bad))
    }
  })
})

describe("review: the per-IP limit key (T12)", () => {
  it("treats IPv4-mapped IPv6 and plain IPv4 as one client", () => {
    expect(clientIp("::ffff:203.0.113.9", undefined, 0)).toBe(clientIp("203.0.113.9", undefined, 0))
  })

  it("puts addresses from one IPv6 /64 in one bucket", () => {
    // One host usually controls a whole /64; per-address buckets give it 2^64 budgets.
    // The client IP stays exact (it is what the audit log records); the limiter key is the /64.
    const key = (ip: string) => rateLimitKey(clientIp(ip, undefined, 0))
    expect(key("2001:db8:1:2::a")).toBe(key("2001:db8:1:2:ffff:ffff:ffff:ffff"))
    expect(key("2001:db8:1:2::a")).toBe("2001:db8:1:2::/64")
    expect(key("2001:db8:1:3::a")).not.toBe(key("2001:db8:1:2::a"))
    expect(key("2001:0DB8:0001:0002:0:0:0:1")).toBe("2001:db8:1:2::/64")
    expect(key("::1")).toBe("0:0:0:0::/64")
    expect(key("203.0.113.9")).toBe("203.0.113.9")
  })

  it("never takes a client-written X-Forwarded-For entry with a trusted proxy", () => {
    // One proxy appended "203.0.113.10" (the real client); the client wrote "198.51.100.1".
    expect(clientIp("10.0.0.2", "198.51.100.1, 203.0.113.10", 1)).toBe("203.0.113.10")
  })
})
