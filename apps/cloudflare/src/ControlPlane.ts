import { DurableObject } from "cloudflare:workers"
import { DurableObjectSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/cloudflare"
import { connectors } from "@pi-cloud/connectors"
import { ControlPlane as ControlPlaneApp } from "@pi-cloud/control-plane"
import { RunnerDispatcher } from "@pi-cloud/core"
import { sqliteStoresOn } from "@pi-cloud/storage-sqlite"
import { Redacted } from "effect"
import { CONTROL_PLANE, type Env, INTERNAL_URL, LEGACY_CONTROL_PLANE, near, NotConfigured, quote, schema, settings } from "./env.ts"

const PAGE_BYTES = 8 << 20
const RETRY_MS = 10_000

const size = (value: SqlStorageValue) => typeof value === "string" ? value.length * 2 : value instanceof ArrayBuffer ? value.byteLength : 8

export class ControlPlane extends DurableObject<Env> {
  readonly #inflight = new Set<Promise<Response>>()
  #handler: Promise<(request: Request) => Promise<Response>> | undefined
  #moving: Promise<void> | undefined
  #retryAt = 0
  readonly #database = new DurableObjectSqliteDatabase(this.ctx.storage as never)

  override fetch(request: Request): Promise<Response> {
    if (this.ctx.storage.kv.get("retired") === true) return Promise.resolve(new Response("the control plane has moved", { status: 503 }))
    return this.ctx.id.name === CONTROL_PLANE && this.ctx.storage.kv.get("moved") !== true ? this.#moveOrForward(request) : this.#serve(request)
  }

  async #moveOrForward(request: Request): Promise<Response> {
    if (Date.now() >= this.#retryAt) {
      this.#moving ??= this.#move().finally(() => (this.#moving = undefined))
      try {
        await this.#moving
        return this.#serve(request)
      } catch (error) {
        console.error("control plane move deferred", error)
        this.#retryAt = Date.now() + RETRY_MS
      }
    }
    return this.env.CONTROL_PLANE.getByName(LEGACY_CONTROL_PLANE).fetch(request as never) as unknown as Promise<Response>
  }

  #serve(request: Request): Promise<Response> {
    this.#handler ??= this.#start()
    this.#handler.catch(() => (this.#handler = undefined))
    const response = this.#handler.then(
      (handler) => handler(request),
      (error) => {
        if (!(error instanceof NotConfigured)) throw error
        return new Response(error.message, { status: 503 })
      }
    )
    const settle = () => this.#inflight.delete(response)
    this.#inflight.add(response)
    response.then(settle, settle)
    return response
  }

  async retire() {
    const objects = schema(this.ctx.storage.sql)
    if (objects.length === 0) return []
    this.ctx.storage.kv.put("retired", true)
    await Promise.race([Promise.allSettled(this.#inflight), scheduler.wait(5_000)])
    return objects
  }

  rows(table: string, after: number) {
    const page: Array<Array<SqlStorageValue>> = []
    let bytes = 0
    for (const row of this.ctx.storage.sql.exec(`SELECT rowid, * FROM ${quote(table)} WHERE rowid > ? ORDER BY rowid`, after).raw()) {
      page.push(row)
      bytes += row.reduce<number>((sum, value) => sum + size(value), 0)
      if (bytes > PAGE_BYTES) break
    }
    return page
  }

  async #move() {
    const { sql, kv } = this.ctx.storage
    const legacy = this.env.CONTROL_PLANE.getByName(LEGACY_CONTROL_PLANE)
    const present = new Set(schema(sql).map((object) => object.name))
    for (const { type, name, sql: create } of await legacy.retire()) {
      if (!present.has(name)) sql.exec(create)
      if (type !== "table") continue
      const copied = `copied:${name}`
      for (let rows; (rows = await legacy.rows(name, kv.get<number>(copied) ?? 0)).length > 0;) {
        for (const [, ...values] of rows) sql.exec(`INSERT INTO ${quote(name)} VALUES (${values.map(() => "?").join()})`, ...values)
        kv.put(copied, rows.at(-1)![0])
      }
    }
    kv.put("moved", true)
  }

  async #start() {
    const env = await settings(this.env)
    const { handler } = ControlPlaneApp.toWebHandler({
      settings: { ...env.settings, publicUrl: INTERNAL_URL },
      auth: env.auth,
      apiKeys: env.apiKeys.map((key) => Redacted.value(key)),
      runnerSecret: Redacted.value(env.runnerSecret),
      ...sqliteStoresOn(async () => this.#database, { credentialKeys: env.credentialKeys.map((key) => Redacted.value(key)) }),
      ...connectors(env),
      dispatcher: RunnerDispatcher.make((wake) => this.env.SESSION_HOST.getByName(wake.sessionId, near(this.env)).wake(wake))
    })
    return (request: Request) => handler(request)
  }
}
