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

export type ReplicaDatabase = () => Promise<SqliteDatabase>

const quoteName = (name: string) => `"${name.replaceAll('"', '""')}"`

const fromBase64 = (text: string) => {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export const loadDump = async (database: SqliteDatabase, dump: StorageDump) => {
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

export class ReplicatedStorage implements Storage {
  private readonly remote: RemoteStorage
  private local: SqliteStorage | undefined
  private readonly onDrop: (reason: string) => void
  private committing: Promise<unknown> = Promise.resolve()

  private constructor(remote: RemoteStorage, local: SqliteStorage | undefined, onDrop: (reason: string) => void) {
    this.remote = remote
    this.local = local
    this.onDrop = onDrop
  }

  static async open(
    remote: RemoteStorage,
    dump: StorageDump | undefined,
    database: ReplicaDatabase | undefined,
    onDrop: (reason: string) => void = () => {}
  ): Promise<ReplicatedStorage> {
    if (dump === undefined || database === undefined) return new ReplicatedStorage(remote, undefined, onDrop)
    const db = await database()
    try {
      await loadDump(db, dump)
      const local = await SqliteStorage.open(db, dump.prefix === undefined ? {} : { prefix: dump.prefix })
      remote.seed(await local.mintId())
      return new ReplicatedStorage(remote, local, onDrop)
    } catch (error) {
      await db.close().catch(() => {})
      onDrop(`the replica could not be loaded: ${error instanceof Error ? error.message : String(error)}`)
      return new ReplicatedStorage(remote, undefined, onDrop)
    }
  }

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

  abandon(): void {
    this.remote.abandon()
  }
}
