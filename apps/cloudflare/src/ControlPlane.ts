import { DurableObject } from "cloudflare:workers"
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare"
import { connectors } from "@pi-cloud/connectors"
import { ControlPlane as ControlPlaneApp } from "@pi-cloud/control-plane"
import { RunnerDispatcher } from "@pi-cloud/core"
import { sqliteStoresOn } from "@pi-cloud/storage-sqlite"
import { Redacted } from "effect"
import { type Env, INTERNAL_URL, NotConfigured, settings } from "./env.ts"

export class ControlPlane extends DurableObject<Env> {
  #handler: Promise<(request: Request) => Promise<Response>> | undefined

  override fetch(request: Request): Promise<Response> {
    this.#handler ??= this.#start()
    this.#handler.catch(() => (this.#handler = undefined))
    return this.#handler.then(
      (handler) => handler(request),
      (error) => {
        if (!(error instanceof NotConfigured)) throw error
        return new Response(error.message, { status: 503 })
      }
    )
  }

  async #start() {
    const env = await settings(this.env)
    const database = new DurableObjectSqliteDatabase(this.ctx.storage as never)
    const { handler } = ControlPlaneApp.toWebHandler({
      settings: { ...env.settings, publicUrl: INTERNAL_URL },
      auth: env.auth,
      apiKeys: env.apiKeys.map((key) => Redacted.value(key)),
      runnerSecret: Redacted.value(env.runnerSecret),
      ...sqliteStoresOn(async () => database, { credentialKeys: env.credentialKeys.map((key) => Redacted.value(key)) }),
      ...connectors(env),
      dispatcher: RunnerDispatcher.make((wake) => this.env.SESSION_HOST.getByName(wake.sessionId, { locationHint: this.env.PI_CLOUD_LOCATION ?? "wnam" }).wake(wake))
    })
    return (request: Request) => handler(request)
  }
}
