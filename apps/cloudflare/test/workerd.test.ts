import type { ConversationView } from "@earendil-works/pi-durable"
import { connectServices } from "@pi-cloud/client"
import { type ChildProcess, spawn } from "node:child_process"
import { createHmac } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const port = 46_000 + Math.floor(Math.random() * 2_000)
const url = `http://127.0.0.1:${port}`
const apiKey = "test-api-key"
const auth = { authorization: `Bearer ${apiKey}` }
let state: string
const states: Array<string> = []
let wrangler: ChildProcess | undefined

const fresh = async () => {
  state = await mkdtemp(join(tmpdir(), "pi-cloud-workerd-"))
  states.push(state)
}
const start = async (main?: string, health = 204) => {
  wrangler = spawn("npx", ["wrangler", "dev", ...(main ? [main] : []), "--port", String(port), "--inspector-port", String(port + 10_000), "--ip", "127.0.0.1", "--persist-to", state,
    "--var", `PI_CLOUD_API_KEYS:${apiKey}`, "--var", "PI_CLOUD_RUNNER_SECRET:test-runner-secret", "--var",
    `PI_CLOUD_CREDENTIAL_KEY:${"k".repeat(32)}`, "--var", "GITHUB_WEBHOOK_SECRET:hook"], {
    cwd: join(import.meta.dirname, ".."),
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
    stdio: "ignore",
    detached: true
  })
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) }).then((response) => response.status === health, () => false)) return
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
  await fresh()
  await start()
}, 90_000)
afterAll(async () => {
  await stop()
  await Promise.all(states.map((dir) => rm(dir, { recursive: true, force: true })))
})

const api = (path: string, method?: "PUT" | "POST", body?: unknown) =>
  fetch(`${url}${path}`, { method, headers: { ...auth, "content-type": "application/json" }, body: method && JSON.stringify(body) })
    .then((response) => response.json()) as Promise<Record<string, unknown>>

const answer = async (provider: string, modelId: string, expires: number) => {
  await api(`/v1/credentials/${provider}`, "PUT", { type: "oauth", access: "sk-ant-oat01-fake", refresh: "sk-ant-ort01-fake", expires })
  const session = await api("/v1/sessions", "POST", { spec: { model: { provider, modelId } } })
  const { submissionId } = await api(`/v1/sessions/${session.id}/messages`, "POST", { content: "hello" })
  for (let attempt = 0; attempt < 100; attempt++) {
    const record = await api(`/v1/sessions/${session.id}/submissions/${submissionId}`)
    if (record.status === "done" || record.status === "unanswered") return String(record.detail)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error("submission did not settle")
}

const hook = JSON.stringify({
  action: "opened",
  repository: { full_name: "acme/api" },
  sender: { login: "octocat", type: "User" },
  issue: { number: 1, title: "Hi", author_association: "OWNER", html_url: "https://github.com/acme/api/issues/1" }
})
const signature = `sha256=${createHmac("sha256", "hook").update(hook).digest("hex")}`
const delivered = async (headers: Record<string, string> = { "x-hub-signature-256": signature }) =>
  (await fetch(`${url}/v1/triggers/github`, { method: "POST", body: hook, headers: { "x-github-event": "issues", ...headers } })).status

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

    expect(await delivered({})).toBe(401)
    expect(await delivered()).toBe(202)

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

  it("uses and refreshes subscription logins through statically loaded OAuth flows", async () => {
    expect(await answer("anthropic", "claude-haiku-4-5", Date.now() + 3_600_000)).not.toMatch(/endsWith/)
    expect(await answer("anthropic", "claude-haiku-4-5", Date.now() - 1_000)).not.toMatch(/endsWith/)
    expect(await answer("openai-codex", "gpt-5.5", Date.now() - 1_000)).not.toMatch(/endsWith/)
  }, 60_000)
})

describe("the control plane next to its session hosts", () => {
  const sessions = async () =>
    (await fetch(`${url}/v1/sessions`, { headers: auth }).then((response) => response.json()) as Array<{ id: string; title?: string }>)
      .map(({ id, title }) => ({ id, title }))

  it("moves an existing deployment's state out of the old object once and never uses it again", async () => {
    await stop()
    await fresh()
    await start("test/legacy.worker.ts")
    await api("/v1/credentials/anthropic", "PUT", { type: "api_key", key: "sk-ant-legacy" })
    const created = await api("/v1/sessions", "POST", { title: "before the move", spec: {} })
    expect(await delivered()).toBe(202)
    const { submissionId } = await api(`/v1/sessions/${created.id}/messages`, "POST", { content: "hello" })
    const submission = `/v1/sessions/${created.id}/submissions/${submissionId}`
    for (let attempt = 0; attempt < 100 && (await api(submission)).status !== "unanswered"; attempt++) await new Promise((resolve) => setTimeout(resolve, 200))
    const before = await Promise.all([sessions(), api(submission), api(`/v1/sessions/${created.id}/entries?limit=100`)])
    await stop()

    await start()
    expect(await Promise.all([sessions(), api(submission), api(`/v1/sessions/${created.id}/entries?limit=100`)])).toEqual(before)
    expect(before[0]).toHaveLength(2)
    expect(before[1].status).toBe("unanswered")
    expect(entries(before[2])).toEqual(["pi.user"])
    expect(await api("/v1/credentials")).toEqual(expect.arrayContaining([expect.objectContaining({ providerId: "anthropic" })]))
    expect(await delivered()).toBe(202)
    expect(await sessions()).toEqual(before[0])
    await api("/v1/sessions", "POST", { title: "after the move", spec: {} })
    await stop()

    await start("test/legacy.worker.ts", 503)
    expect(await fetch(`${url}/v1/sessions`, { headers: auth }).then((response) => response.text())).toBe("the control plane has moved")
    await stop()
    await start()
    expect(await sessions()).toHaveLength(3)
  }, 120_000)

  it("starts a fresh deployment under the new name and leaves the old one alone", async () => {
    await stop()
    await fresh()
    await start()
    await api("/v1/sessions", "POST", { title: "fresh", spec: {} })
    await stop()
    await start("test/legacy.worker.ts")
    expect(await sessions()).toEqual([])
  }, 120_000)
})
