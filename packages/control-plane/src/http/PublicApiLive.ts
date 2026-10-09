import { parsePosition } from "@pi-cloud/core"
import { CommandFailed, PublicApi, type SessionId, type Submitted } from "@pi-cloud/protocol"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { Sessions } from "../Sessions.ts"

/** The REST surface: a thin mapping from `PublicApi` endpoints onto the `Sessions` service. */
export const SessionsApiLive = HttpApiBuilder.group(
  PublicApi,
  "sessions",
  Effect.fn(function*(handlers) {
    const sessions = yield* Sessions
    return handlers
      .handle("create", ({ payload }) => sessions.create(payload))
      .handle("list", () => sessions.list())
      .handle("get", ({ params }) => sessions.get(params.id))
      .handle("delete", ({ params }) => sessions.remove(params.id))
      .handle("submit", ({ params, payload }) =>
        sessions.command(params.id, { _tag: "Prompt", ...payload }).pipe(Effect.map((value) => value as Submitted)))
      .handle("command", ({ params, payload }) =>
        sessions.command(params.id, payload).pipe(Effect.map((value) => ({ value: value as never }))))
      .handle("abort", ({ params, payload }) =>
        sessions.command(params.id, { _tag: "Abort", ...payload }).pipe(
          Effect.asVoid,
          Effect.catchTag("ConversationBusy", (error) => Effect.fail(new CommandFailed({ message: error._tag })))
        ))
      .handle("events", ({ params, query }) => sessions.events(params.id, parsePosition(query.after)))
      .handle("entries", ({ params, query }) =>
        sessions.entries(params.id, query).pipe(Effect.map((page) => page as { entries: Array<never>; next?: string })))
      .handle("conversations", ({ params }) =>
        sessions.conversations(params.id).pipe(Effect.map((items) => items as Array<never>)))
      .handle("submission", ({ params }) =>
        sessions.submission(params.id as SessionId, params.submissionId).pipe(Effect.map((record) => record as never)))
  })
)

export const SystemApiLive = HttpApiBuilder.group(PublicApi, "system", (handlers) =>
  Effect.succeed(handlers.handle("health", () => Effect.void)))

export const PublicApiHandlers = Layer.mergeAll(SessionsApiLive, SystemApiLive)
