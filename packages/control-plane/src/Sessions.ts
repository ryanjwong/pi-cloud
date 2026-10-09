import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import {
  type ConversationId,
  type Cursor,
  ROOT_CONVERSATION_ID,
  type Storage,
  type SubmissionId
} from "@earendil-works/pi-durable"
import { EventHub, LeaseManager, SessionStore, StateStore, storageFailure, type StreamPosition } from "@pi-cloud/core"
import {
  CommandFailed,
  type CommandResult,
  ConversationBusy,
  type EventBatch,
  RunnerUnavailable,
  Session,
  SessionId,
  SessionNotFound,
  type SessionCommand,
  type SessionSpec,
  type SessionView
} from "@pi-cloud/protocol"
import { Clock, Context, Effect, Layer, Option, type Stream } from "effect"
import { Runners } from "./Runners.ts"

/** Round-trip through JSON: drops `undefined` fields exactly as a serializing backend would. */
export const toJson = (value: unknown): unknown => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url")
const decodeCursor = (cursor: string): Cursor => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))

export type CommandError = SessionNotFound | RunnerUnavailable | ConversationBusy | CommandFailed

/**
 * Everything you can do with sessions, as one service. The REST API, the WebSocket channel, and any source
 * hosted in the control plane (a Slack bridge, a webhook trigger, ...) are thin adapters over it, so they all
 * have the same capabilities and semantics.
 */
export class Sessions extends Context.Service<Sessions, {
  create(input: { readonly title?: string | undefined; readonly spec?: SessionSpec | undefined }): Effect.Effect<SessionView>
  list(): Effect.Effect<ReadonlyArray<SessionView>>
  get(id: string): Effect.Effect<SessionView, SessionNotFound>
  remove(id: string): Effect.Effect<void, SessionNotFound>
  /** Run a command on the session's runner, starting one if needed. Resolves with the command's value. */
  command(id: string, command: SessionCommand): Effect.Effect<unknown, CommandError>
  /** Buffered then live event batches. */
  events(id: string, after: StreamPosition | undefined): Effect.Effect<Stream.Stream<EventBatch>, SessionNotFound>
  /** Transcript entries, oldest first, read from the state store. */
  entries(id: string, query: {
    readonly conversationId?: number | undefined
    readonly limit?: number | undefined
    readonly cursor?: string | undefined
  }): Effect.Effect<{ readonly entries: ReadonlyArray<unknown>; readonly next?: string | undefined }, SessionNotFound>
  conversations(id: string): Effect.Effect<ReadonlyArray<unknown>, SessionNotFound>
  submission(id: string, submissionId: number): Effect.Effect<unknown, SessionNotFound>
}>()("@pi-cloud/control-plane/Sessions") {
  static readonly layer: Layer.Layer<
    Sessions,
    never,
    SessionStore | StateStore | LeaseManager | EventHub | Runners
  > = Layer.effect(
    Sessions,
    Effect.gen(function*() {
      const store = yield* SessionStore
      const states = yield* StateStore
      const leases = yield* LeaseManager
      const runners = yield* Runners
      const hub = yield* EventHub

      const find = Effect.fnUntraced(function*(id: string) {
        const session = yield* store.get(id as SessionId).pipe(Effect.orDie)
        if (Option.isNone(session)) return yield* new SessionNotFound({ sessionId: id })
        return session.value
      })

      const view = Effect.fnUntraced(function*(session: Session) {
        const lease = yield* leases.current(session.id)
        const starting = yield* runners.starting(session.id)
        const runner: SessionView["runner"] = Option.isSome(lease)
          ? { state: "running", runnerId: lease.value.runnerId, leaseExpiresAt: lease.value.expiresAt }
          : { state: starting ? "starting" : "idle" }
        return { id: session.id, title: session.title, spec: session.spec, createdAt: session.createdAt, runner }
      })

      /** Read from the session's storage; storage failures are defects here, not API errors. */
      const read = <A>(id: string, f: (storage: Storage) => Promise<A>) =>
        Effect.gen(function*() {
          yield* find(id)
          const storage = yield* states.open(id).pipe(Effect.orDie)
          return yield* Effect.tryPromise({ try: () => f(storage), catch: storageFailure }).pipe(Effect.orDie)
        })

      const settle = (sessionId: string, result: CommandResult): Effect.Effect<unknown, CommandError> => {
        if (result._tag === "Ok") return Effect.succeed(result.value)
        switch (result.tag) {
          case "ConversationBusy":
            return Effect.fail(new ConversationBusy({ sessionId }))
          case "LeaseLost":
            return Effect.fail(new RunnerUnavailable({ sessionId, message: result.message }))
          default:
            return Effect.fail(new CommandFailed({ message: result.message, reason: result.tag }))
        }
      }

      return Sessions.of({
        create: Effect.fnUntraced(function*(input) {
          const session = new Session({
            id: SessionId.make(`ses_${crypto.randomUUID().replaceAll("-", "")}`),
            title: input.title,
            spec: input.spec ?? {},
            createdAt: yield* Clock.currentTimeMillis
          })
          yield* store.put(session).pipe(Effect.orDie)
          return yield* view(session)
        }),
        list: () => store.list().pipe(Effect.orDie, Effect.flatMap((all) => Effect.forEach(all, view))),
        get: (id) => Effect.flatMap(find(id), view),
        remove: Effect.fnUntraced(function*(id) {
          yield* find(id)
          yield* runners.shutdown(id, "The session was deleted")
          yield* leases.remove(id)
          yield* hub.remove(id)
          yield* states.remove(id).pipe(Effect.orDie)
          yield* store.remove(id as SessionId).pipe(Effect.orDie)
        }),
        command: Effect.fnUntraced(function*(id, command) {
          const session = yield* find(id)
          return yield* settle(session.id, yield* runners.send(session, command))
        }),
        events: (id, after) => Effect.map(find(id), () => hub.subscribe(id, after)),
        entries: (id, query) =>
          read(id, async (storage) => {
            const page = await storage.scanEntries(
              { conversationId: (query.conversationId ?? ROOT_CONVERSATION_ID) as ConversationId, order: "ascending" },
              Math.min(query.limit ?? 100, 1000),
              query.cursor === undefined ? undefined : decodeCursor(query.cursor),
              BACKGROUND_CONTEXT
            )
            return {
              entries: toJson(page.items) as ReadonlyArray<unknown>,
              next: page.next === undefined ? undefined : encodeCursor(page.next)
            }
          }),
        conversations: (id) =>
          read(id, async (storage) =>
            toJson((await storage.scanConversations({}, 1000, undefined, BACKGROUND_CONTEXT)).items) as ReadonlyArray<
              unknown
            >),
        submission: (id, submissionId) =>
          read(id, async (storage) =>
            toJson(await storage.submission(submissionId as SubmissionId, BACKGROUND_CONTEXT)) ?? null)
      })
    })
  )
}
