// Starts a real Studio (the built `kervan-studio` bin) on a free port with a throwaway data
// directory and master key, and reads the one-time setup token from its console.
import { type ChildProcess, spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "kervan-studio.js")

export interface RunningStudio {
  url: string
  setupToken: string
  stop: () => Promise<void>
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      )
    })
  })
}

export async function launchStudio(): Promise<RunningStudio> {
  const port = await freePort()
  const dataDir = mkdtempSync(path.join(tmpdir(), "kervan-studio-e2e-"))
  const url = `http://127.0.0.1:${port}`
  const child: ChildProcess = spawn(process.execPath, [BIN, "start"], {
    env: {
      ...process.env,
      KERVAN_STUDIO_PUBLIC_URL: url,
      KERVAN_STUDIO_PORT: String(port),
      KERVAN_STUDIO_DATA_DIR: dataDir,
      KERVAN_STUDIO_MASTER_KEY: randomBytes(32).toString("base64"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  })

  let output = ""
  const setupToken = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Studio did not start:\n${output}`)), 30_000)
    const read = (chunk: Buffer) => {
      output += chunk.toString()
      const token = /one-time token[^\n]*\n\s+(\S+)/.exec(output)?.[1]
      if (token && output.includes("listening on")) {
        clearTimeout(timer)
        resolve(token)
      }
    }
    child.stdout?.on("data", read)
    child.stderr?.on("data", read)
    child.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`Studio exited (${code}):\n${output}`))
    })
  })

  return {
    url,
    setupToken,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve))
        child.kill()
        await exited
      }
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

/** A throwaway password for a test account (never a real credential). */
export function testPassword(): string {
  return `e2e-${randomBytes(12).toString("base64url")}`
}
