import type { SqliteDatabase, SqliteExecutor } from "@earendil-works/pi-durable/storage/sqlite"
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite"
import {
  type Binding,
  BindingStore,
  CredentialStore,
  credentialSealer,
  SessionStore,
  StateStore,
  type VersionedCredential
} from "@pi-cloud/core"
import { Session, SessionId, type StorageDump, StorageFailure } from "@pi-cloud/protocol"
import { Context, Effect, Layer, Option, Schema } from "effect"

/**
 * The control plane's database: one SQLite database and one connection, shared by every store, through Pi's async
 * SQLite adapter (Node's `node:sqlite`, a Durable Object's storage, ...). The adapter queues each operation behind any
 * open transaction, so the stores never interleave with a commit, and the database is the whole state of the control
 * plane.
 */
export class SqliteFile extends Context.Service<SqliteFile, SqliteDatabase>()("@pi-cloud/storage-sqlite/SqliteFile") {
  /** The database `open` returns, with pi-cloud's tables created; closed with the layer. */
  static readonly layer = (open: () => Promise<SqliteDatabase>): Layer.Layer<SqliteFile> =>
    Layer.effect(
      SqliteFile,
      Effect.acquireRelease(
        Effect.promise(async () => {
          const db = await open()
          await db.exec(SCHEMA)
          return db
        }),
        (db) => Effect.promise(() => db.close().catch(() => {}))
      )
    )
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bindings (key TEXT PRIMARY KEY, source TEXT, record TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS credentials (provider_id TEXT PRIMARY KEY, sealed TEXT NOT NULL, version INTEGER NOT NULL, updated_at INTEGER NOT NULL);
`

const attempt = <A>(f: () => Promise<A>) =>
  Effect.tryPromise({ try: f, catch: (cause) => new StorageFailure({ message: cause instanceof Error ? cause.message : String(cause) }) })

/** The ids pi-cloud mints. Their tables keep the names they have always had. */
const MINTED = /^ses_[0-9a-f]{32}$/

/**
 * Each session's Pi tables carry its own prefix in the shared file, and the prefixes must keep sessions apart:
 * distinct ids never share one, and no prefix starts another (or one session's `LIKE 'prefix%'` would reach into
 * another's tables). Any other id is escaped so that every `_` is followed by `u`, `h` or `x`, so the escape never
 * contains `__`, which then ends the prefix.
 */
export const sessionPrefix = (sessionId: string) => {
  if (MINTED.test(sessionId)) return `s_${sessionId}_`
  let escaped = ""
  for (const char of sessionId) {
    if (/[A-Za-z0-9]/.test(char)) escaped += char
    else if (char === "_") escaped += "_u"
    else if (char === "-") escaped += "_h"
    else escaped += `_x${char.codePointAt(0)!.toString(16).padStart(6, "0")}`
  }
  return `s_${escaped}__`
}

/** A shared database whose `close` leaves it open: Pi's storage closes what it was opened on. */
const borrowed = (db: SqliteDatabase): SqliteDatabase => ({
  exec: (sql) => db.exec(sql),
  run: (sql, ...params) => db.run(sql, ...params),
  get: (sql, ...params) => db.get(sql, ...params),
  all: (sql, ...params) => db.all(sql, ...params),
  transaction: (callback) => db.transaction(callback),
  close: async () => {}
})

const toBase64 = (bytes: Uint8Array) => {
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x2000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x2000))
  return btoa(binary)
}

const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`
const escapeLike = (prefix: string) => prefix.replace(/[\\%_]/g, (c) => `\\${c}`)

/** The tables, indexes, triggers and views of one prefix, tables first. */
const objectsOf = (executor: SqliteExecutor, prefix: string) =>
  executor.all<{ type: string; name: string; sql: string }>(
    `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name LIKE ? ESCAPE '\\' ORDER BY type = 'table' DESC, rowid`,
    `${escapeLike(prefix)}%`
  )

/** One session's Pi tables, read in one transaction: the schema statements, then the rows. */
export const dumpSqlite = (db: SqliteDatabase, prefix: string): Promise<StorageDump> =>
  db.transaction(async (transaction) => {
    const objects = await objectsOf(transaction, prefix)
    const tables = []
    for (const { name } of objects.filter((object) => object.type === "table")) {
      const rows = await transaction.all<Record<string, unknown>>(`SELECT * FROM ${quoteName(name)}`)
      const columns = rows.length === 0 ? [] : Object.keys(rows[0]!)
      tables.push({
        name,
        columns,
        rows: rows.map((row) =>
          columns.map((column) => {
            const value = row[column]
            if (value instanceof Uint8Array || value instanceof ArrayBuffer) return { base64: toBase64(new Uint8Array(value)) }
            return typeof value === "bigint" ? Number(value) : (value as null | number | string)
          })
        )
      })
    }
    return { prefix, schema: objects.map((object) => object.sql), tables }
  })

/** Pi Durable's own SQLite storage for every session, in the shared file. */
const state: Layer.Layer<StateStore, never, SqliteFile> = Layer.unwrap(Effect.map(SqliteFile, (db) =>
  StateStore.fromOpener({
    open: (sessionId) => SqliteStorage.open(borrowed(db), { prefix: sessionPrefix(sessionId) }),
    dump: (sessionId) => dumpSqlite(db, sessionPrefix(sessionId)),
    remove: (sessionId) =>
      db.transaction(async (transaction) => {
        for (const object of await objectsOf(transaction, sessionPrefix(sessionId))) {
          if (object.type === "table") await transaction.exec(`DROP TABLE IF EXISTS ${quoteName(object.name)}`)
        }
      })
  })
))

const encodeSession = Schema.encodeSync(Session)
const decodeSession = Schema.decodeUnknownSync(Session)

const sessions: Layer.Layer<SessionStore, never, SqliteFile> = Layer.effect(SessionStore, Effect.map(SqliteFile, (db) => {
  const parse = (row: { record: string }) => decodeSession(JSON.parse(row.record))
  return SessionStore.of({
    put: (session) =>
      attempt(() =>
        db.run(
          "INSERT INTO sessions (id, created_at, record) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record",
          session.id,
          session.createdAt,
          JSON.stringify(encodeSession(session))
        )
      ),
    get: (id: SessionId) =>
      attempt(async () => Option.fromUndefinedOr(await db.get<{ record: string }>("SELECT record FROM sessions WHERE id = ?", id)).pipe(Option.map(parse))),
    list: () => attempt(async () => (await db.all<{ record: string }>("SELECT record FROM sessions ORDER BY created_at")).map(parse)),
    remove: (id) => attempt(() => db.run("DELETE FROM sessions WHERE id = ?", id))
  })
}))

const bindings: Layer.Layer<BindingStore, never, SqliteFile> = Layer.effect(BindingStore, Effect.map(SqliteFile, (db) => {
  const parse = (row: { record: string }): Binding => JSON.parse(row.record)
  return BindingStore.of({
    get: (key) =>
      attempt(async () => Option.fromUndefinedOr(await db.get<{ record: string }>("SELECT record FROM bindings WHERE key = ?", key)).pipe(Option.map(parse))),
    put: (binding) =>
      attempt(() =>
        db.run(
          "INSERT INTO bindings (key, source, record) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET source = excluded.source, record = excluded.record",
          binding.key,
          binding.source ?? null,
          JSON.stringify(binding)
        )
      ),
    list: (source) =>
      attempt(async () =>
        (source === undefined
          ? await db.all<{ record: string }>("SELECT record FROM bindings")
          : await db.all<{ record: string }>("SELECT record FROM bindings WHERE source = ?", source)).map(parse)
      ),
    remove: (key) => attempt(() => db.run("DELETE FROM bindings WHERE key = ?", key))
  })
}))

/**
 * Credentials, sealed with AES-256-GCM when `key` is given (see `credentialSealer`). Writes are compare-and-swap on
 * the version, inside one transaction.
 */
const credentials = (key: string | undefined): Layer.Layer<CredentialStore, never, SqliteFile> =>
  Layer.effect(CredentialStore, Effect.map(SqliteFile, (db) => {
    const sealer = credentialSealer(key)
    type Row = { provider_id: string; sealed: string; version: number; updated_at: number }
    const columns = "provider_id, sealed, version, updated_at"
    const parse = (row: Row): VersionedCredential => ({
      providerId: row.provider_id,
      credential: sealer.open(row.sealed),
      version: row.version,
      updatedAt: row.updated_at
    })
    return CredentialStore.of({
      get: (providerId) =>
        attempt(async () =>
          Option.fromUndefinedOr(await db.get<Row>(`SELECT ${columns} FROM credentials WHERE provider_id = ?`, providerId)).pipe(Option.map(parse))
        ),
      list: () => attempt(async () => (await db.all<Row>(`SELECT ${columns} FROM credentials ORDER BY provider_id`)).map(parse)),
      put: (providerId, credential, expectedVersion) =>
        attempt(() =>
          db.transaction(async (transaction) => {
            const current = (await transaction.get<Row>(`SELECT ${columns} FROM credentials WHERE provider_id = ?`, providerId))?.version ?? 0
            if (expectedVersion !== undefined && expectedVersion !== current) return { stored: false, version: current }
            const now = Date.now()
            if (current === 0) {
              await transaction.run("INSERT INTO credentials (provider_id, sealed, version, updated_at) VALUES (?, ?, ?, ?)", providerId, sealer.seal(credential), 1, now)
            } else {
              await transaction.run(
                "UPDATE credentials SET sealed = ?, version = ?, updated_at = ? WHERE provider_id = ? AND version = ?",
                sealer.seal(credential),
                current + 1,
                now,
                providerId,
                current
              )
            }
            return { stored: true, version: current + 1 }
          })
        ),
      remove: (providerId) => attempt(() => db.run("DELETE FROM credentials WHERE provider_id = ?", providerId))
    })
  }))

/**
 * Every control-plane store in one SQLite database: the session registry, each session's Pi state (tables prefixed
 * per session), bindings, and credentials. The layers share one connection when built together, as
 * `ControlPlane.layer` builds its stores. `sqliteStores` in `./node` opens a file; on Cloudflare, pass a Durable
 * Object's storage (`new DurableObjectSqliteDatabase(ctx.storage)`).
 */
export const sqliteStoresOn = (
  open: () => Promise<SqliteDatabase>,
  options: { readonly credentialKey?: string | undefined } = {}
) => {
  const database = SqliteFile.layer(open)
  return {
    sessions: sessions.pipe(Layer.provide(database)),
    state: state.pipe(Layer.provide(database)),
    bindings: bindings.pipe(Layer.provide(database)),
    credentials: credentials(options.credentialKey).pipe(Layer.provide(database))
  }
}
