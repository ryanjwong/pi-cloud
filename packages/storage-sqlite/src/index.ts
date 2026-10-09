import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { type Binding, BindingStore, SessionStore, StateStore } from "@pi-cloud/core"
import { Session, SessionId, StorageFailure } from "@pi-cloud/protocol"
import { Effect, Layer, Option, Schema } from "effect"
import { mkdirSync } from "node:fs"
import { rm } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"

const fileName = (sessionId: string) => `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.sqlite`

/**
 * Pi Durable's own SQLite storage, one database file per session in `directory`. WAL mode: commits survive a
 * control-plane crash; the newest may be lost on power or host failure.
 */
export const sqliteState = (options: { readonly directory: string }): Layer.Layer<StateStore> =>
  StateStore.fromOpener({
    open: (sessionId) => openNodeSqliteStorage(join(options.directory, fileName(sessionId))),
    remove: async (sessionId) => {
      const base = join(options.directory, fileName(sessionId))
      await Promise.all(["", "-wal", "-shm"].map((suffix) => rm(base + suffix, { force: true })))
    }
  })

const encodeSession = Schema.encodeSync(Session)
const decodeSession = Schema.decodeUnknownSync(Session)

/** The session registry in one SQLite file. */
export const sqliteSessions = (options: { readonly file: string }): Layer.Layer<SessionStore> =>
  Layer.effect(
    SessionStore,
    Effect.acquireRelease(
      Effect.sync(() => {
        mkdirSync(dirname(options.file), { recursive: true })
        const db = new DatabaseSync(options.file)
        db.exec("PRAGMA journal_mode = WAL")
        db.exec("PRAGMA busy_timeout = 5000")
        db.exec(
          "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, record TEXT NOT NULL)"
        )
        return db
      }),
      (db) => Effect.sync(() => db.close())
    ).pipe(Effect.map((db) => {
      const attempt = <A>(f: () => A) =>
        Effect.try({ try: f, catch: (cause) => new StorageFailure({ message: String(cause) }) })
      const put = db.prepare(
        "INSERT INTO sessions (id, created_at, record) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record"
      )
      const get = db.prepare("SELECT record FROM sessions WHERE id = ?")
      const list = db.prepare("SELECT record FROM sessions ORDER BY created_at")
      const remove = db.prepare("DELETE FROM sessions WHERE id = ?")
      const parse = (row: unknown) => decodeSession(JSON.parse((row as { record: string }).record))
      return SessionStore.of({
        put: (session) => attempt(() => void put.run(session.id, session.createdAt, JSON.stringify(encodeSession(session)))),
        get: (id: SessionId) => attempt(() => Option.fromUndefinedOr(get.get(id)).pipe(Option.map(parse))),
        list: () => attempt(() => list.all().map(parse)),
        remove: (id) => attempt(() => void remove.run(id))
      })
    }))
  )

/** Bindings from external keys to sessions, in one SQLite file (it may be the sessions file). */
export const sqliteBindings = (options: { readonly file: string }): Layer.Layer<BindingStore> =>
  Layer.effect(
    BindingStore,
    Effect.acquireRelease(
      Effect.sync(() => {
        mkdirSync(dirname(options.file), { recursive: true })
        const db = new DatabaseSync(options.file)
        db.exec("PRAGMA journal_mode = WAL")
        db.exec("PRAGMA busy_timeout = 5000")
        db.exec("CREATE TABLE IF NOT EXISTS bindings (key TEXT PRIMARY KEY, source TEXT, record TEXT NOT NULL)")
        return db
      }),
      (db) => Effect.sync(() => db.close())
    ).pipe(Effect.map((db) => {
      const attempt = <A>(f: () => A) =>
        Effect.try({ try: f, catch: (cause) => new StorageFailure({ message: String(cause) }) })
      const put = db.prepare(
        "INSERT INTO bindings (key, source, record) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET source = excluded.source, record = excluded.record"
      )
      const get = db.prepare("SELECT record FROM bindings WHERE key = ?")
      const all = db.prepare("SELECT record FROM bindings")
      const bySource = db.prepare("SELECT record FROM bindings WHERE source = ?")
      const remove = db.prepare("DELETE FROM bindings WHERE key = ?")
      const parse = (row: unknown): Binding => JSON.parse((row as { record: string }).record)
      return BindingStore.of({
        get: (key) => attempt(() => Option.fromUndefinedOr(get.get(key)).pipe(Option.map(parse))),
        put: (binding) => attempt(() => void put.run(binding.key, binding.source ?? null, JSON.stringify(binding))),
        list: (source) => attempt(() => (source === undefined ? all.all() : bySource.all(source)).map(parse)),
        remove: (key) => attempt(() => void remove.run(key))
      })
    }))
  )
