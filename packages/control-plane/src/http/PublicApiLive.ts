import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { type ConversationId, type Cursor, ROOT_CONVERSATION_ID, type SubmissionId } from "@earendil-works/pi-durable"
import {
  CommandFailed,
  type CommandResult,
  ConversationBusy,
  PublicApi,
  RunnerUnavailable,
  Session,
  SessionId,
  SessionNotFound,
  type SessionView
} from "@pi-cloud/protocol"
import { Clock, Effect, Layer, Option } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { EventHub, parsePosition } from "../ports/EventHub.ts"
import { LeaseManager } from "../ports/LeaseManager.ts"
import { SessionStore, storageFailure } from "../ports/SessionStore.ts"
import { StateStore } from "../ports/StateStore.ts"
import { Runners } from "../Runners.ts"
import { toJson } from "./RunnerRpcLive.ts"

const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url")
const decodeCursor = (cursor: string): Cursor => JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))

export const SessionsApiLive = HttpApiBuilder.group(
  PublicApi,
  "sessions",
  Effect.fn(function*(handlers) {
    const sessions = yield* SessionStore
    const states = yield* StateStore
    const leases = yield* LeaseManager
    const runners = yield* Runners
    const events = yield* EventHub

    const find = Effect.fnUntraced(function*(id: SessionId) {
      const session = yield* sessions.get(id).pipe(Effect.orDie)
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

    const storage = (id: SessionId) => states.open(id).pipe(Effect.orDie)

    /** Turn a runner's command result into the endpoint's value or typed error. */
    const settle = (
      sessionId: string,
      result: CommandResult
    ): Effect.Effect<unknown, ConversationBusy | RunnerUnavailable | CommandFailed> => {
      if (result._tag === "Ok") return Effect.succeed(result.value)
      if (result.tag === "ConversationBusy") return Effect.fail(new ConversationBusy({ sessionId }))
      if (result.tag === "LeaseLost") {
        return Effect.fail(new RunnerUnavailable({ sessionId, message: result.message }))
      }
      return Effect.fail(new CommandFailed({ message: result.message }))
    }

    return handlers
      .handle("create", ({ payload }) =>
        Effect.gen(function*() {
          const session = new Session({
            id: SessionId.make(`ses_${crypto.randomUUID().replaceAll("-", "")}`),
            title: payload.title,
            spec: payload.spec ?? {},
            createdAt: yield* Clock.currentTimeMillis
          })
          yield* sessions.put(session).pipe(Effect.orDie)
          return yield* view(session)
        }))
      .handle("list", () =>
        sessions.list().pipe(Effect.orDie, Effect.flatMap((all) => Effect.forEach(all, view))))
      .handle("get", ({ params }) => Effect.flatMap(find(params.id), view))
      .handle("delete", ({ params }) =>
        Effect.gen(function*() {
          yield* find(params.id)
          yield* runners.shutdown(params.id, "The session was deleted")
          yield* leases.remove(params.id)
          yield* events.remove(params.id)
          yield* states.remove(params.id).pipe(Effect.orDie)
          yield* sessions.remove(params.id).pipe(Effect.orDie)
        }))
      .handle("submit", ({ params, payload }) =>
        Effect.gen(function*() {
          const session = yield* find(params.id)
          const result = yield* runners.send(session, { _tag: "Submit", ...payload })
          return (yield* settle(session.id, result)) as { submissionId: number; conversationId: number }
        }))
      .handle("abort", ({ params, payload }) =>
        Effect.gen(function*() {
          const session = yield* find(params.id)
          yield* settle(session.id, yield* runners.send(session, { _tag: "Abort", ...payload })).pipe(
            Effect.catchTag("ConversationBusy", (error) => Effect.fail(new CommandFailed({ message: error._tag })))
          )
        }))
      .handle("events", ({ params, query }) =>
        Effect.map(find(params.id), () => events.subscribe(params.id, parsePosition(query.after))))
      .handle("entries", ({ params, query }) =>
        Effect.gen(function*() {
          yield* find(params.id)
          const store = yield* storage(params.id)
          const page = yield* Effect.tryPromise({
            try: () =>
              store.scanEntries(
                {
                  conversationId: (query.conversationId ?? ROOT_CONVERSATION_ID) as ConversationId,
                  order: "ascending"
                },
                Math.min(query.limit ?? 100, 1000),
                query.cursor === undefined ? undefined : decodeCursor(query.cursor),
                BACKGROUND_CONTEXT
              ),
            catch: storageFailure
          }).pipe(Effect.orDie)
          return {
            entries: toJson(page.items) as Array<never>,
            next: page.next === undefined ? undefined : encodeCursor(page.next)
          }
        }))
      .handle("conversations", ({ params }) =>
        Effect.gen(function*() {
          yield* find(params.id)
          const store = yield* storage(params.id)
          const page = yield* Effect.tryPromise({
            try: () => store.scanConversations({}, 1000, undefined, BACKGROUND_CONTEXT),
            catch: storageFailure
          }).pipe(Effect.orDie)
          return toJson(page.items) as Array<never>
        }))
      .handle("submission", ({ params }) =>
        Effect.gen(function*() {
          yield* find(params.id)
          const store = yield* storage(params.id)
          const record = yield* Effect.tryPromise({
            try: () => store.submission(params.submissionId as SubmissionId, BACKGROUND_CONTEXT),
            catch: storageFailure
          }).pipe(Effect.orDie)
          return (toJson(record) ?? null) as never
        }))
  })
)

export const SystemApiLive = HttpApiBuilder.group(PublicApi, "system", (handlers) =>
  Effect.succeed(handlers.handle("health", () => Effect.void)))

export const PublicApiHandlers = Layer.mergeAll(SessionsApiLive, SystemApiLive)
