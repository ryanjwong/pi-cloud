import { DurableObject } from "cloudflare:workers"
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare"
import { ControlPlane as ControlPlaneApp } from "@pi-cloud/control-plane"
import { RunnerDispatcher } from "@pi-cloud/core"
import { sqliteStoresOn } from "@pi-cloud/storage-sqlite"
import { Option, Redacted } from "effect"
import { type Env, INTERNAL_URL, settings } from "./env.ts"

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
    return this.#handler.then((handler) => handler(request))
  }

  async #start() {
    const env = await settings(this.env)
    const secret = (value: Option.Option<Redacted.Redacted<string>>) => Option.getOrUndefined(Option.map(value, Redacted.value))
    const database = new DurableObjectSqliteDatabase(this.ctx.storage as never)
    const { handler } = ControlPlaneApp.toWebHandler({
      settings: { publicUrl: INTERNAL_URL },
      apiKeys: env.apiKeys.map((key) => Redacted.value(key)),
      ...sqliteStoresOn(async () => database, { credentialKey: secret(env.credentialKey) }),
      // A session's runner is its own Durable Object.
      dispatcher: RunnerDispatcher.make((wake) => this.env.SESSION_HOST.getByName(wake.sessionId).wake(wake))
    })
    return (request: Request) => handler(request)
  }
}
