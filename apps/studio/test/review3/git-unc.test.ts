// Security review 3: the start-up git check in an untrusted repository (data-dir.ts).
//
// The check runs git with program-running settings turned off on the command line and a clean
// environment. But a repository's own `.git/config` (an extracted archive is owned by the user who
// extracted it, so git's ownership check passes and the config is read) can still name *files*
// git opens: `core.excludesFile`, `include.path`, `core.worktree`, a `.git` file's `gitdir:`. On
// Windows a path like `//host/share/x` is opened over SMB, which sends the user's NTLM credentials
// (a crackable hash) to `host`. Here `host` is 127.0.0.1 and the "share" is a named pipe this test
// listens on, so a connection proves git opened a network path the repository chose.
import { execFileSync, spawn } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { dataDirectoryGitWarning } from "../../src/data-dir.js"
import { DATABASE_FILE } from "../../src/server.js"

const cleanups: (() => unknown)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

/** Listens on a local named pipe; `connections` counts who opened it (over SMB via 127.0.0.1). */
async function pipeServer() {
  const name = `kervan-review3-${process.pid}-${Math.random().toString(36).slice(2)}`
  const state = { connections: 0 }
  const server = net.createServer((socket) => {
    state.connections++
    socket.on("error", () => {})
    socket.end("*\n")
  })
  // \\.\pipe\<name>, built without typing backslash escapes that tools may mangle.
  const local = ["", "", ".", "pipe", name].join("\\")
  await new Promise<void>((resolve) => server.listen(local, resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  return { state, unc: `//127.0.0.1/pipe/${name}` }
}

function repository() {
  const root = mkdtempSync(path.join(os.tmpdir(), "kervan-review3-git-"))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const repo = path.join(root, "repo")
  execFileSync("git", ["init", "-q", repo])
  const data = path.join(repo, "data")
  mkdirSync(data)
  writeFileSync(path.join(data, DATABASE_FILE), "")
  return { root, repo, data }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 300))

describe.runIf(process.platform === "win32" && hasGit)(
  "the start-up git check in a repository whose config names a network path",
  () => {
    it("does not open a UNC path the repository's core.excludesFile names", async () => {
      const { state, unc } = await pipeServer()
      const { repo, data } = repository()
      execFileSync("git", ["-C", repo, "config", "core.excludesFile", unc])

      dataDirectoryGitWarning(data, path.join(data, DATABASE_FILE))
      await settle()
      expect(state.connections).toBe(0)
    })

    it("does not open a UNC path the repository's include.path names", async () => {
      // git reads an include to its end, so the pipe is served from another process (this one is
      // blocked while the check runs git synchronously).
      const name = `kervan-review3-${process.pid}-${Math.random().toString(36).slice(2)}`
      const server = spawn(
        process.execPath,
        [
          "-e",
          `const net = require("node:net"); let n = 0
           const s = net.createServer((c) => { n++; c.on("error", () => {}); c.end("") })
           s.listen(["", "", ".", "pipe", process.argv[1]].join(String.fromCharCode(92)), () => console.log("ready"))
           process.stdin.on("data", () => { console.log("connections=" + n); process.exit(0) })`,
          name,
        ],
        { stdio: ["pipe", "pipe", "inherit"] },
      )
      cleanups.push(() => server.kill())
      let out = ""
      server.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString()
      })
      await expect.poll(() => out.includes("ready")).toBe(true)
      const { repo, data } = repository()
      appendFileSync(
        path.join(repo, ".git", "config"),
        `[include]\n\tpath = //127.0.0.1/pipe/${name}\n`,
      )

      dataDirectoryGitWarning(data, path.join(data, DATABASE_FILE))
      server.stdin.write("report\n")
      await expect.poll(() => /connections=\d+/.exec(out)?.[0]).toBeDefined()
      expect(/connections=(\d+)/.exec(out)?.[1]).toBe("0")
    }, 60_000)

    // A `.git` *file* in any parent folder of the data directory (git walks up to the drive's
    // root) points git elsewhere with `gitdir:`. git opens the target before its ownership check
    // (setup.c: read_gitfile_gently -> is_git_directory, then ensure_valid_ownership), so even a
    // `.git` planted by another local user (in a folder they can write, such as the root of a
    // non-system drive) makes it connect. Here the data directory is in no repository at all.
    it("does not open a UNC path that a .git file in a parent folder names", async () => {
      // git opens <gitdir>/HEAD first; with gitdir "//127.0.0.1/pipe" that is the pipe "HEAD".
      const server = spawn(
        process.execPath,
        [
          "-e",
          `const net = require("node:net"); let n = 0
           const s = net.createServer((c) => { n++; c.on("error", () => {}); c.end("") })
           s.on("error", (e) => { console.log("listen-failed " + e.code); process.exit(1) })
           s.listen(["", "", ".", "pipe", "HEAD"].join(String.fromCharCode(92)), () => console.log("ready"))
           process.stdin.on("data", () => { console.log("connections=" + n); process.exit(0) })`,
        ],
        { stdio: ["pipe", "pipe", "inherit"] },
      )
      cleanups.push(() => server.kill())
      let out = ""
      server.stdout.on("data", (chunk: Buffer) => {
        out += chunk.toString()
      })
      await expect.poll(() => /ready|listen-failed/.exec(out)?.[0]).toBe("ready")
      const root = mkdtempSync(path.join(os.tmpdir(), "kervan-review3-gitfile-"))
      cleanups.push(() => rmSync(root, { recursive: true, force: true }))
      writeFileSync(path.join(root, ".git"), "gitdir: //127.0.0.1/pipe\n")
      const data = path.join(root, "project", "data")
      mkdirSync(data, { recursive: true })
      writeFileSync(path.join(data, DATABASE_FILE), "")

      dataDirectoryGitWarning(data, path.join(data, DATABASE_FILE))
      server.stdin.write("report\n")
      await expect.poll(() => /connections=\d+/.exec(out)?.[0]).toBeDefined()
      expect(/connections=(\d+)/.exec(out)?.[1]).toBe("0")
    }, 60_000)
  },
)
