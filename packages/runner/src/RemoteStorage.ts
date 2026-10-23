import type { Context } from "@earendil-works/chord"
import type {
  ConversationId,
  ConversationQuery,
  ConversationRecord,
  Cursor,
  DocumentAddress,
  DocumentId,
  DocumentPoint,
  DocumentQuery,
  DocumentRecord,
  EntryId,
  EntryQuery,
  EntryRecord,
  Id,
  Page,
  Seq,
  Storage,
  StorageWrite,
  StoredDocument,
  SubmissionId,
  SubmissionQuery,
  SubmissionRecord,
  TaskId,
  TaskQuery,
  TaskRecord
} from "@earendil-works/pi-durable"
import { StorageRequestError } from "@earendil-works/pi-durable"
import type { StorageMethod } from "@pi-cloud/protocol"

export type StorageTransport = (method: StorageMethod, args: ReadonlyArray<unknown>, requestId?: string) => Promise<unknown>

export class LeaseLostError extends Error {
  readonly sessionId: string
  constructor(sessionId: string) {
    super(`Lost the lease on session ${sessionId}`)
    this.sessionId = sessionId
    this.name = "LeaseLostError"
  }
}

export class StorageBackendError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StorageBackendError"
  }
}

const RETRY_FOR_MS = 30_000

const encodeArgs = (args: ReadonlyArray<unknown>) =>
  args.map((arg) => arg === undefined ? null : JSON.parse(JSON.stringify(arg)))

const writeId = (write: StorageWrite): number | undefined => {
  switch (write.type) {
    case "conversation":
    case "entry":
    case "task":
    case "submission":
      return write.value.id
    case "document.create":
    case "document.copy":
      return write.record.id
    default:
      return undefined
  }
}

export class RemoteStorage implements Storage {
  private nextId: number | undefined
  private minting: Promise<number> | undefined
  private closed = false
  private abandoned = false

  private readonly transport: StorageTransport

  constructor(transport: StorageTransport) {
    this.transport = transport
  }

  private async call<T>(method: StorageMethod, ...args: Array<unknown>): Promise<T> {
    if (this.abandoned) return new Promise<T>(() => {})
    if (this.closed) throw new Error("RemoteStorage is closed")
    const encoded = encodeArgs(args)
    const requestId = method === "commit" ? crypto.randomUUID() : undefined
    const deadline = Date.now() + RETRY_FOR_MS
    for (let delay = 100;; delay = Math.min(delay * 2, 2_000)) {
      try {
        return await this.transport(method, encoded, requestId) as T
      } catch (error) {
        const final = error instanceof LeaseLostError || error instanceof StorageRequestError ||
          error instanceof StorageBackendError || this.closed || Date.now() + delay > deadline
        if (final) throw error
        if (this.abandoned) return new Promise<T>(() => {})
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }
  }

  async commit(writes: ReadonlyArray<StorageWrite>, _context: Context): Promise<Seq> {
    const seq = await this.call<Seq>("commit", writes)
    if (this.nextId !== undefined) {
      for (const write of writes) {
        const id = writeId(write)
        if (id !== undefined && id >= this.nextId) this.nextId = id + 1
      }
    }
    return seq
  }

  seed(nextId: number): void {
    this.nextId ??= nextId
  }

  async mintId<I extends Id<string>>(): Promise<I> {
    if (this.closed) throw new Error("RemoteStorage is closed")
    if (this.nextId === undefined) {
      this.minting ??= this.call<number>("mintId")
      const base = await this.minting
      this.nextId ??= base
    }
    if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted")
    return this.nextId++ as I
  }

  conversation(id: ConversationId, _context: Context): Promise<ConversationRecord | undefined> {
    return this.call("conversation", id)
  }

  scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context
  ): Promise<Page<ConversationRecord, Cursor>> {
    return this.call("scanConversations", query, limit, cursor)
  }

  entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>
  entry(
    conversationId: ConversationId,
    id: EntryId,
    context: Context
  ): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>
  entry(first: number, second: unknown, _third?: Context) {
    return typeof second === "number"
      ? this.call<{ entry: EntryRecord; commitSeq: Seq } | undefined>("entry", first, second)
      : this.call<{ entry: EntryRecord; commitSeq: Seq } | undefined>("entry", first)
  }

  findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    _context: Context
  ): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    return this.call("findLatestHeadMarker", conversationId, atOrBeforeEntryId)
  }

  scanEntries(query: EntryQuery, limit: number, cursor: Cursor | undefined, _context: Context): Promise<Page<EntryRecord, Cursor>> {
    return this.call("scanEntries", query, limit, cursor)
  }

  task(id: TaskId, _context: Context): Promise<TaskRecord<any, any, any> | undefined> {
    return this.call("task", id)
  }

  scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context
  ): Promise<Page<TaskRecord<any, any, any>, Cursor>> {
    return this.call("scanTasks", query, limit, cursor)
  }

  submission(id: SubmissionId, _context: Context): Promise<SubmissionRecord | undefined> {
    return this.call("submission", id)
  }

  scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context
  ): Promise<Page<SubmissionRecord, Cursor>> {
    return this.call("scanSubmissions", query, limit, cursor)
  }

  submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    _context: Context
  ): Promise<SubmissionRecord | undefined> {
    return this.call("submissionByRequest", conversationId, requestId)
  }

  findDocument(address: DocumentAddress, at: DocumentPoint, _context: Context): Promise<DocumentRecord | undefined> {
    return this.call("findDocument", address, at)
  }

  document(id: DocumentId, at: DocumentPoint, _context: Context): Promise<StoredDocument | undefined> {
    return this.call("document", id, at)
  }

  scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    _context: Context
  ): Promise<Page<DocumentRecord, Cursor>> {
    return this.call("scanDocuments", query, limit, cursor)
  }

  abandon(): void {
    this.abandoned = true
  }

  async close(_context: Context): Promise<void> {
    this.closed = true
  }
}
