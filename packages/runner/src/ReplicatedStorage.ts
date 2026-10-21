import type { Context } from "@earendil-works/chord"
import type {
  ConversationId,
  ConversationQuery,
  Cursor,
  DocumentAddress,
  DocumentId,
  DocumentPoint,
  DocumentQuery,
  EntryId,
  EntryQuery,
  Id,
  Seq,
  Storage,
  StorageWrite,
  SubmissionId,
  SubmissionQuery,
  TaskId,
  TaskQuery
} from "@earendil-works/pi-durable"
import { type SqliteDatabase, SqliteStorage, type SqliteValue } from "@earendil-works/pi-durable/storage/sqlite"
import type { StorageDump } from "@pi-cloud/protocol"
import type { RemoteStorage } from "./RemoteStorage.ts"

/** Opens an empty local SQLite database for a session's replica: in memory on Node, a Durable Object's own, ... */
export type ReplicaDatabase = () => Promise<SqliteDatabase>

const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`

const fromBase64 = (text: string) => {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Load a dump into an empty database: its schema, then its rows, in one transaction. */
const load = async (database: SqliteDatabase, dump: StorageDump) => {
  for (const statement of dump.schema) await database.exec(statement)
  await database.transaction(async (transaction) => {
    for (const table of dump.tables) {
      if (table.rows.length === 0) continue
      const sql = `INSERT INTO ${quoteName(table.name)} (${table.columns.map(quoteName).join(", ")}) VALUES (${
        table.columns.map(() => "?").join(", ")
      })`
      for (const row of table.rows) {
        const values: Array<SqliteValue> = row.map((value) =>
          value !== null && typeof value === "object" ? fromBase64(value.base64) : value
        )
        await transaction.run(sql, ...values)
      }
    }
  })
}

/**
 * A session's storage with reads served from a local replica. The replica starts as a copy of the control plane's
 * SQLite tables and applies every commit after the control plane has: this runner is the session's only writer
 * while it holds the lease, so the replica is never behind on anything it reads. Pi's SQLite storage numbers
 * commits from its own tables, so both copies must agree on each commit's sequence; if they ever disagree, or the
 * replica fails, it is dropped and reads go to the control plane again.
 */
export class ReplicatedStorage implements Storage {
  private readonly remote: RemoteStorage
  private local: SqliteStorage | undefined
  private readonly onDrop: (reason: string) => void
  /** Commits run one at a time, so the replica applies them in the control plane's order. */
  private committing: Promise<unknown> = Promise.resolve()

  private constructor(remote: RemoteStorage, local: SqliteStorage | undefined, onDrop: (reason: string) => void) {
    this.remote = remote
    this.local = local
    this.onDrop = onDrop
  }

  /** Storage over `remote`, with a replica loaded from `dump` when there is one and a database to load it into. */
  static async open(
    remote: RemoteStorage,
    dump: StorageDump | undefined,
    database: ReplicaDatabase | undefined,
    onDrop: (reason: string) => void = () => {}
  ): Promise<ReplicatedStorage> {
    if (dump === undefined || database === undefined) return new ReplicatedStorage(remote, undefined, onDrop)
    const db = await database()
    try {
      await load(db, dump)
      return new ReplicatedStorage(remote, await SqliteStorage.open(db), onDrop)
    } catch (error) {
      await db.close().catch(() => {})
      onDrop(`the replica could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
      return new ReplicatedStorage(remote, undefined, onDrop)
    }
  }

  /** Whether reads are served locally. */
  get replicated(): boolean {
    return this.local !== undefined
  }

  private drop(reason: string) {
    const local = this.local
    if (local === undefined) return
    this.local = undefined
    this.onDrop(reason)
    void local.close(undefined as never).catch(() => {})
  }

  private get reader(): Storage {
    return this.local ?? this.remote
  }

  commit(writes: ReadonlyArray<StorageWrite>, context: Context): Promise<Seq> {
    const run = async () => {
      const seq = await this.remote.commit(writes, context)
      const local = this.local
      if (local !== undefined) {
        try {
          const replicated = await local.commit(writes, context)
          if (replicated !== seq) this.drop(`the replica numbered commit ${seq} as ${replicated}`)
        } catch (error) {
          this.drop(`the replica refused commit ${seq}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      return seq
    }
    const result = this.committing.then(run, run)
    this.committing = result.catch(() => {})
    return result
  }

  // IDs are minted by the remote storage, which owns the namespace for this lease.
  mintId<I extends Id<string>>(): Promise<I> {
    return this.remote.mintId<I>()
  }

  conversation(id: ConversationId, context: Context) {
    return this.reader.conversation(id, context)
  }

  scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, context: Context) {
    return this.reader.scanConversations(query, limit, cursor, context)
  }

  entry(id: EntryId, context: Context): ReturnType<Storage["entry"]>
  entry(conversationId: ConversationId, id: EntryId, context: Context): ReturnType<Storage["entry"]>
  entry(first: number, second: unknown, third?: Context) {
    return typeof second === "number"
      ? this.reader.entry(first as ConversationId, second as EntryId, third!)
      : this.reader.entry(first as EntryId, second as Context)
  }

  findLatestHeadMarker(conversationId: ConversationId, atOrBeforeEntryId: EntryId | undefined, context: Context) {
    return this.reader.findLatestHeadMarker(conversationId, atOrBeforeEntryId, context)
  }

  scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, context: Context) {
    return this.reader.scanEntries(query, limit, cursor, context)
  }

  task(id: TaskId, context: Context) {
    return this.reader.task(id, context)
  }

  scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, context: Context) {
    return this.reader.scanTasks(query, limit, cursor, context)
  }

  submission(id: SubmissionId, context: Context) {
    return this.reader.submission(id, context)
  }

  scanSubmissions(query: SubmissionQuery, limit: number, cursor: Cursor | undefined, context: Context) {
    return this.reader.scanSubmissions(query, limit, cursor, context)
  }

  submissionByRequest(conversationId: ConversationId, requestId: string, context: Context) {
    return this.reader.submissionByRequest(conversationId, requestId, context)
  }

  findDocument(address: DocumentAddress, at: DocumentPoint, context: Context) {
    return this.reader.findDocument(address, at, context)
  }

  document(id: DocumentId, at: DocumentPoint, context: Context) {
    return this.reader.document(id, at, context)
  }

  scanDocuments(query: DocumentQuery, limit: number, cursor: Cursor | undefined, context: Context) {
    return this.reader.scanDocuments(query, limit, cursor, context)
  }

  async close(context: Context): Promise<void> {
    const local = this.local
    this.local = undefined
    await Promise.all([this.remote.close(context), local?.close(context)])
  }

  /** Stop at once, as a crash would. */
  abandon(): void {
    this.remote.abandon()
  }
}
