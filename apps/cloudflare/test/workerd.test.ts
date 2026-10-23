import type { ConversationView } from "@earendil-works/pi-durable"
import { connectServices } from "@pi-cloud/client"
import { createHmac } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { unstable_startWorker } from "wrangler"

type Worker = Awaited<ReturnType<typeof unstable_startWorker>>

const apiKey = "test-api-key"
const auth = { authorization: `Bearer ${apiKey}` }
const root = join(import.meta.dirname, "..")
const vars = { PI_CLOUD_API_KEYS: apiKey, PI_CLOUD_RUNNER_SECRET: "test-runner-secret", PI_CLOUD_CREDENTIAL_KEY: "k".repeat(32), GITHUB_WEBHOOK_SECRET: "hook" }
let url: string
let state: string
const states: Array<string> = []
let worker: Worker | undefined

const fresh = async () => {
  state = await mkdtemp(join(tmpdir(), "pi-cloud-workerd-"))
  states.push(state)
}
const start = async (main?: string, health = 204) => {
  worker = await unstable_startWorker({
    config: join(root, "wrangler.json"),
    ...(main ? { entrypoint: join(root, main) } : {}),
    bindings: Object.fromEntries(Object.entries(vars).map(([name, value]) => [name, { type: "plain_text", value }])),
    dev: { server: { hostname: "127.0.0.1", port: 0 }, inspector: false, persist: state, watch: false }
  })
  url = (await worker.url).origin
  expect((await fetch(`${url}/health`)).status).toBe(health)
}
const stop = async () => {
  await worker?.dispose()
  worker = undefined
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

const settle = async (sessionId: unknown, submissionId: unknown) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const record = await api(`/v1/sessions/${sessionId}/submissions/${submissionId}`)
    if (record.status === "done" || record.status === "unanswered") return record
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error("submission did not settle")
}

const answer = async (provider: string, modelId: string, expires: number) => {
  await api(`/v1/credentials/${provider}`, "PUT", { type: "oauth", access: "sk-ant-oat01-fake", refresh: "sk-ant-ort01-fake", expires })
  const session = await api("/v1/sessions", "POST", { spec: { model: { provider, modelId } } })
  const { submissionId } = await api(`/v1/sessions/${session.id}/messages`, "POST", { content: "hello" })
  return String((await settle(session.id, submissionId)).detail)
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
    await settle(created.id, submissionId)
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

  it("keeps serving from the old object while it still runs the previous code, then moves", async () => {
    await stop()
    await fresh()
    await start("test/legacy.worker.ts")
    await api("/v1/sessions", "POST", { title: "before", spec: {} })
    const before = await sessions()
    await stop()

    await start("test/stale.worker.ts")
    expect(await sessions()).toEqual(before)
    await api("/v1/sessions", "POST", { title: "during", spec: {} })
    await stop()

    await start()
    expect((await sessions()).map(({ title }) => title).sort()).toEqual(["before", "during"])
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

describe("Pi's coding agent on Cloudflare", () => {
  it("sends the model Pi's prompt, its subagent tool and the sandbox working tree's AGENTS.md", async () => {
    await stop()
    await fresh()
    await start("test/prompt.worker.ts")
    const session = await api("/v1/sessions", "POST", { spec: { model: { provider: "faux", modelId: "faux-1" } } })
    const { submissionId } = await api(`/v1/sessions/${session.id}/messages`, "POST", { content: "who are you?" })
    await settle(session.id, submissionId)
    const { entries } = await api(`/v1/sessions/${session.id}/entries?limit=100`) as { entries: Array<{ kind: string; model: Array<{ content: Array<{ text: string }> }> }> }
    const sent = entries.find((entry) => entry.kind === "pi.assistant")?.model[0]?.content[0]?.text
    for (const part of [
      "You are an expert coding assistant operating inside pi, a coding agent harness.",
      "Use bash for file operations like ls, rg, find",
      '<project_instructions path="/home/daytona/repo/AGENTS.md">\nRun the linter before every commit.',
      "<cwd>\n/home/daytona/repo\n</cwd>",
      "tool: subagent"
    ]) expect(sent).toContain(part)
  }, 120_000)
})
