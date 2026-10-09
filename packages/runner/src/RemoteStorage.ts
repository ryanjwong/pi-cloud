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
import type { StorageMethod } from "@pi-cloud/protocol"

/** Sends one storage call to the control plane and resolves with its JSON result. */
export type StorageTransport = (method: StorageMethod, args: ReadonlyArray<unknown>) => Promise<unknown>

/** Thrown when the control plane refuses a call because this runner no longer holds the session's lease. */
export class LeaseLostError extends Error {
  readonly sessionId: string
  constructor(sessionId: string) {
    super(`Lost the lease on session ${sessionId}`)
    this.sessionId = sessionId
    this.name = "LeaseLostError"
  }
}

/** JSON has no `undefined`; the control plane turns `null` arguments back into `undefined`. */
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

/**
 * Pi Durable `Storage` that lives in the control plane. Every call is one RPC; commits are fenced by this runner's
 * lease there. IDs are minted locally from a base fetched once, since this runner is the session's only writer
 * while it holds the lease and Storage treats minted IDs as candidates checked at commit.
 */
export class RemoteStorage implements Storage {
  private nextId: number | undefined
  private minting: Promise<number> | undefined
  private closed = false
  private abandoned = false

  private readonly transport: StorageTransport

  constructor(transport: StorageTransport) {
    this.transport = transport
  }

  private call<T>(method: StorageMethod, ...args: Array<unknown>): Promise<T> {
    if (this.abandoned) return new Promise<T>(() => {})
    if (this.closed) return Promise.reject(new Error("RemoteStorage is closed"))
    return this.transport(method, encodeArgs(args)) as Promise<T>
  }

  async commit(writes: ReadonlyArray<StorageWrite>, _context: Context): Promise<Seq> {
    const seq = await this.call<Seq>("commit", writes)
    // Committed IDs claim the namespace, exactly as the backend's own minting would observe.
    if (this.nextId !== undefined) {
      for (const write of writes) {
        const id = writeId(write)
        if (id !== undefined && id >= this.nextId) this.nextId = id + 1
      }
    }
    return seq
  }

  async mintId<I extends Id<string>>(): Promise<I> {
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

  /**
   * Stop talking to the control plane the way a crashed process would: every later call simply never settles.
   * Used when a runner is torn down without a clean shutdown.
   */
  abandon(): void {
    this.abandoned = true
  }

  /** The control plane owns the backend; closing only stops this client. */
  async close(_context: Context): Promise<void> {
    this.closed = true
  }
}
