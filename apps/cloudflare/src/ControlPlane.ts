import { DurableObject } from "cloudflare:workers"
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare"
import { ControlPlane as ControlPlaneApp } from "@pi-cloud/control-plane"
import { RunnerDispatcher } from "@pi-cloud/core"
import { sqliteStoresOn } from "@pi-cloud/storage-sqlite"
import { Redacted } from "effect"
import { type Env, INTERNAL_URL, NotConfigured, settings } from "./env.ts"

/**
 * The control plane, as one Durable Object. Its SQLite holds everything pi-cloud keeps: the session registry,
 * bindings, credentials, and every session's Pi state (tables prefixed per session), so it is the one central
 * store, with Cloudflare's point-in-time recovery. Leases, event fan-out and the service API's Chord host live in
 * its memory, which lasts as long as anything talks to it; runners renew their leases every few seconds.
 */
export class ControlPlane extends DurableObject<Env> {
  #handler: Promise<(request: Request) => Promise<Response>> | undefined

  override fetch(request: Request): Promise<Response> {
    this.#handler ??= this.#start()
    this.#handler.catch(() => (this.#handler = undefined))
    return this.#handler.then(
      (handler) => handler(request),
      // Fail closed: an unconfigured deployment serves nothing.
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
      settings: { publicUrl: INTERNAL_URL },
      apiKeys: env.apiKeys.map((key) => Redacted.value(key)),
      // Session hosts reach the control plane object directly, but the runner channel still checks the secret.
      runnerSecret: Redacted.value(env.runnerSecret),
      ...sqliteStoresOn(async () => database, { credentialKey: Redacted.value(env.credentialKey) }),
      // A session's runner is its own Durable Object.
      dispatcher: RunnerDispatcher.make((wake) => this.env.SESSION_HOST.getByName(wake.sessionId).wake(wake))
    })
    return (request: Request) => handler(request)
  }
}
