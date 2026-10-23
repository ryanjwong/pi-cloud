import { DurableObject } from "cloudflare:workers"
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare"
import { modelCredentialLookup } from "@pi-cloud/config"
import type { WakeRequest } from "@pi-cloud/protocol"
import { CodingTools } from "@earendil-works/pi-durable/tools"
import { extensions, modelProviders, type ReplicaDatabase, RunnerHost } from "@pi-cloud/runner"
import { sandboxes } from "@pi-cloud/sandbox"
import { daytonaSandboxes } from "@pi-cloud/sandbox-daytona"
import { githubTools } from "@pi-cloud/tool-github"
import { Option, Redacted } from "effect"
import { controlPlane, type Env, INTERNAL_URL, settings, wipe } from "./env.ts"

const KEEPALIVE_MS = 20_000

registerBunOAuthFlows()

export class SessionHost extends DurableObject<Env> {
  #host: Promise<RunnerHost> | undefined

  async wake(request: WakeRequest): Promise<void> {
    this.#host ??= this.#start()
    await (await this.#host).wake(request)
    await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS)
  }

  override async alarm(): Promise<void> {
    const host = await this.#host
    if (host !== undefined && host.hosted().length > 0) await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_MS)
  }

  async #start() {
    const env = await settings(this.env)
    const stub = controlPlane(this.env)
    return new RunnerHost({
      controlPlaneUrl: INTERNAL_URL,
      secret: Redacted.value(env.runnerSecret),
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => stub.fetch(new Request(input, init) as never)) as unknown as typeof fetch,
      modelCredentials: modelCredentialLookup(env),
      plugins: [
        modelProviders(anthropicProvider, openaiProvider, openaiCodexProvider),
        extensions("coding", CodingTools),
        sandboxes({
          providers: Option.match(env.daytonaApiKey, {
            onNone: () => [],
            onSome: (apiKey) => [daytonaSandboxes({ apiKey: Redacted.value(apiKey) })]
          })
        }),
        githubTools()
      ],
      replica: this.#replica
    })
  }

  readonly #replica: ReplicaDatabase = async () => {
    wipe(this.ctx.storage.sql)
    return new DurableObjectSqliteDatabase(this.ctx.storage as never)
  }
}
