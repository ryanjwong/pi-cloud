import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { unstable_startWorker } from "wrangler"

let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined
let probe: string
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
  worker = await unstable_startWorker({
    config: join(import.meta.dirname, "daytona-probe.json"),
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist: false, watch: false }
  })
  probe = (await worker.url).origin
}, 90_000)
afterAll(async () => {
  await worker?.dispose()
  await new Promise((resolve) => api.close(resolve))
})

describe("Daytona sandboxes on workerd", () => {
  it("reach the Daytona API with the key, and report its refusal as a sandbox error", async () => {
    const url = `http://127.0.0.1:${(api.address() as AddressInfo).port}`
    const response = await fetch(`${probe}/?api=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(60_000) })
    const { exit } = await response.json() as { exit: string }
    const rest = received.filter((call) => !call.path.startsWith("/socket.io/"))
    expect(rest.map((call) => `${call.method} ${call.path}`)).toEqual(expect.arrayContaining(["POST /sandbox"]))
    expect(rest[0]!.path).toMatch(/^\/sandbox\/pi-cloud-probe-home-[0-9a-f]+$/)
    for (const call of rest) expect(call.authorization).toBe("Bearer probe-key")
    expect(exit).toContain("SandboxError: invalid api key")
  }, 90_000)
})
