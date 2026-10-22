import { type ChildProcess, spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const port = 48_000 + Math.floor(Math.random() * 1_000)
let wrangler: ChildProcess | undefined
let api: Server
const received: Array<{ method: string; path: string; authorization: string | undefined }> = []

beforeAll(async () => {
  api = createServer((request, response) => {
    received.push({ method: request.method!, path: request.url!, authorization: request.headers.authorization })
    request.resume()
    request.on("end", () => {
      response.writeHead(401, { "content-type": "application/json" })
      response.end(JSON.stringify({ message: "invalid api key", statusCode: 401 }))
    })
  })
  await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve))
  wrangler = spawn("npx", ["wrangler", "dev", "-c", "test/daytona-probe.json", "--port", String(port), "--ip", "127.0.0.1"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: "ignore",
    detached: true
  })
  for (let attempt = 0; attempt < 120; attempt++) {
    const up = await fetch(`http://127.0.0.1:${port}/cdn-cgi/local/explorer/api`, { signal: AbortSignal.timeout(1_000) }).then(() => true, () => false)
    if (up) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("wrangler dev did not start")
}, 90_000)
afterAll(async () => {
  if (wrangler?.pid !== undefined) process.kill(-wrangler.pid, "SIGTERM")
  await new Promise((resolve) => api.close(resolve))
})

describe("Daytona sandboxes on workerd", () => {
  it("reach the Daytona API with the key, and report its refusal as a sandbox error", async () => {
    const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
    const response = await fetch(`http://127.0.0.1:${port}/?api=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(60_000) })
    const { exit } = await response.json() as { exit: string }
    const rest = received.filter((call) => !call.path.startsWith("/socket.io/"))
    expect(rest.map((call) => `${call.method} ${call.path}`)).toEqual(expect.arrayContaining(["POST /sandbox"]))
    expect(rest[0]!.path).toMatch(/^\/sandbox\/pi-cloud-probe-home-[0-9a-f]+$/)
    for (const call of rest) expect(call.authorization).toBe("Bearer probe-key")
    expect(exit).toContain("SandboxError: invalid api key")
  }, 90_000)
})
