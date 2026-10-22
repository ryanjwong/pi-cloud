import type { Credential, Provider } from "@earendil-works/pi-ai"
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux"
import { PiCloud } from "@pi-cloud/client"
import { modelProviders } from "@pi-cloud/runner"
import { importFromCodex, importFromPi } from "../../../packages/cli/src/login.ts"
import { Effect } from "effect"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { type LocalDeployment, startLocal } from "../src/index.ts"

let deployment: LocalDeployment | undefined
let root: string | undefined
afterEach(async () => {
  await deployment?.stop()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  deployment = undefined
  root = undefined
})

const subscription = () => {
  const faux = fauxProvider()
  const refreshed: Array<string> = []
  const used: Array<string> = []
  const provider: Provider = Object.create(faux.provider, {
    auth: {
      value: {
        oauth: {
          name: "Faux (subscription)",
          isSubscription: true,
          login: async () => ({ type: "oauth", access: "a1", refresh: "r1", expires: Date.now() + 3_600_000 }),
          refresh: async (credential: Credential & { refresh: string }) => {
            refreshed.push(credential.refresh)
            return { type: "oauth", access: "a2", refresh: "r2", expires: Date.now() + 3_600_000 }
          },
          toAuth: async (credential: { access: string }) => {
            used.push(credential.access)
            return { apiKey: credential.access }
          }
        }
      }
    }
  })
  return { faux, provider, refreshed, used }
}

describe("stored credentials", () => {
  it("lets every runner use and refresh a subscription login stored on the control plane", async () => {
    const { faux, provider, refreshed, used } = subscription()
    faux.setResponses([fauxAssistantMessage("Signed in and answering.")])
    deployment = await startLocal({
      port: 41_000 + Math.floor(Math.random() * 10_000),
      runner: { idleMs: 5_000, plugins: [modelProviders(provider)] }
    })
    const url = deployment.url
    const put = (credential: Credential) =>
      fetch(`${url}/v1/credentials/faux`, { method: "PUT", body: JSON.stringify(credential), headers: { "content-type": "application/json" } })

    expect((await put({ type: "oauth", access: "a1", refresh: "r1", expires: Date.now() - 1_000 })).status).toBe(200)
    const listed = await (await fetch(`${url}/v1/credentials`)).json()
    expect(listed).toEqual([{ providerId: "faux", type: "oauth", expires: expect.any(Number), updatedAt: expect.any(Number) }])
    expect(JSON.stringify(listed)).not.toContain("r1")

    await Effect.runPromise(Effect.gen(function*() {
      const client = yield* PiCloud
      const session = yield* client.sessions.create({ payload: { spec: { model: { provider: "faux", modelId: "faux-1" } } } })
      const submitted = yield* client.sessions.submit({ params: { id: session.id }, payload: { content: "hello" } })
      while (true) {
        const record = yield* client.sessions.submission({ params: { id: session.id, submissionId: submitted.submissionId } })
        const status = (record as { status?: string } | null)?.status
        if (status === "done" || status === "unanswered") break
        yield* Effect.sleep(100)
      }
    }).pipe(Effect.provide(PiCloud.layer({ url }))))

    expect(refreshed).toEqual(["r1"])
    expect(used).toContain("a2")
    const after = (await (await fetch(`${url}/v1/credentials`)).json()) as Array<{ expires: number }>
    expect(after[0]!.expires).toBeGreaterThan(Date.now())
  }, 30_000)

  it("imports logins made with Pi or the Codex CLI", async () => {
    root = await mkdtemp(join(tmpdir(), "pi-cloud-logins-"))
    deployment = await startLocal({ port: 41_000 + Math.floor(Math.random() * 10_000), runner: { plugins: [] } })
    const url = deployment.url
    await mkdir(join(root, "pi"))
    await writeFile(join(root, "pi", "auth.json"), JSON.stringify({
      anthropic: { type: "oauth", access: "sk-ant-oat", refresh: "rt", expires: 1 },
      openrouter: { type: "api_key", key: "sk-or" }
    }))
    const exp = Math.floor(Date.now() / 1000) + 600
    const jwt = ["e30", Buffer.from(JSON.stringify({ exp })).toString("base64url"), "sig"].join(".")
    await mkdir(join(root, "codex"))
    await writeFile(join(root, "codex", "auth.json"), JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: "x", access_token: jwt, refresh_token: "codex-refresh", account_id: "acct_1" }
    }))
    process.env.PI_CODING_AGENT_DIR = join(root, "pi")
    process.env.CODEX_HOME = join(root, "codex")
    try {
      await importFromPi({ url }, ["anthropic"])
      await importFromCodex({ url })
    } finally {
      delete process.env.PI_CODING_AGENT_DIR
      delete process.env.CODEX_HOME
    }
    const listed = (await (await fetch(`${url}/v1/credentials`)).json()) as Array<{ providerId: string; type: string; expires?: number }>
    expect(listed.map((entry) => [entry.providerId, entry.type])).toEqual([["anthropic", "oauth"], ["openai-codex", "oauth"]])
    expect(listed.find((entry) => entry.providerId === "openai-codex")!.expires).toBe(exp * 1000)
  }, 30_000)
})
