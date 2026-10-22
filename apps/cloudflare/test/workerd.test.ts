import type { ConversationView } from "@earendil-works/pi-durable"
import { connectServices } from "@pi-cloud/client"
import { type ChildProcess, spawn } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const port = 46_000 + Math.floor(Math.random() * 2_000)
const url = `http://127.0.0.1:${port}`
const apiKey = "test-api-key"
const auth = { authorization: `Bearer ${apiKey}` }
let state: string
let wrangler: ChildProcess | undefined

const start = async () => {
  wrangler = spawn("npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1", "--persist-to", state,
    "--var", `PI_CLOUD_API_KEYS:${apiKey}`, "--var", "PI_CLOUD_RUNNER_SECRET:test-runner-secret", "--var",
    `PI_CLOUD_CREDENTIAL_KEY:${"k".repeat(32)}`], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: "ignore",
    detached: true
  })
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) }).then((response) => response.ok, () => false)) return
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error("wrangler dev did not start")
}
const stop = async () => {
  if (wrangler?.pid !== undefined) process.kill(-wrangler.pid, "SIGTERM")
  wrangler = undefined
  await new Promise((resolve) => setTimeout(resolve, 1_000))
}

beforeAll(async () => {
  state = await mkdtemp(join(tmpdir(), "pi-cloud-workerd-"))
  await start()
}, 90_000)
afterAll(async () => {
  await stop()
  await rm(state, { recursive: true, force: true })
})

const entries = (view: unknown) => (view as ConversationView).entries.map((entry) => entry.kind)

describe("pi-cloud on Cloudflare (local workerd)", () => {
  it("runs sessions in their own objects against the control plane's central store, across restarts", async () => {
    expect((await fetch(`${url}/v1/sessions`)).status).toBe(401)
    expect((await fetch(`${url}/v1/pi`)).status).toBe(401)

    const connection = await connectServices({ url, apiKey })
    const created = await (await connection.sessions()).create({ title: "on cloudflare", spec: {} })
    const main = await connection.conversation(created.id)
    const first = await main.prompt({ message: "hello from workerd" })
    expect(first.accepted).toBe(true)
    expect(await main.waitForPrompt({ operationId: first.accepted ? first.operationId : "" })).toEqual({ status: "unanswered", reason: "no_model" })
    expect(entries(main.view.value)).toEqual(["pi.user"])
    main.release()
    await connection.close()

    for (const path of ["/internal/runner/", "//internal/runner/", "/%69nternal/runner/", "/v1/../internal/runner/", "/v1/%2e%2e/internal/runner/", "/v1%2F..%2Finternal/runner/"]) {
      expect((await fetch(`${url}${path}`, { method: "POST", headers: auth })).status, path).toBe(404)
    }

    await stop()
    await start()
    const listed = await fetch(`${url}/v1/sessions`, { headers: auth }).then((response) => response.json()) as Array<{ id: string; title?: string }>
    expect(listed.find((session) => session.id === created.id)?.title).toBe("on cloudflare")
    const again = await connectServices({ url, apiKey })
    const resumed = await again.conversation(created.id)
    const second = await resumed.prompt({ message: "second prompt" })
    if (second.accepted) await resumed.waitForPrompt({ operationId: second.operationId })
    expect(entries(resumed.view.value)).toEqual(["pi.user", "pi.user"])
    const rest = await fetch(`${url}/v1/sessions/${created.id}/entries?limit=100`, { headers: auth }).then((response) => response.json()) as { entries: Array<{ kind: string }> }
    expect(rest.entries.map((entry) => entry.kind)).toEqual(["pi.user", "pi.user"])
    resumed.release()
    await again.close()
  }, 120_000)
})
