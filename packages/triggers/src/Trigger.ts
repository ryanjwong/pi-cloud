import type { Extension, Trust } from "@pi-cloud/control-plane"
import { Sessions } from "@pi-cloud/control-plane"
import type { SessionSpec, UserContent, WhenBusy } from "@pi-cloud/protocol"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

export interface TriggerEvent extends Trust {
  readonly key: string
  readonly content: UserContent
  readonly requestId?: string | undefined
  readonly title?: string | undefined
  readonly spec?: SessionSpec | undefined
  readonly whenBusy?: WhenBusy | undefined
}

export interface TriggerRequest {
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: string
  readonly url: URL
}

export class TriggerRejected extends Schema.TaggedError<TriggerRejected>()("TriggerRejected", {
  status: Schema.Number,
  message: Schema.String
}) {}

export interface Trigger {
  readonly name: string
  readonly handle: (request: TriggerRequest) => Effect.Effect<ReadonlyArray<TriggerEvent>, TriggerRejected>
}

export const defineTrigger = (trigger: Trigger): Trigger => trigger

export const triggers = (
  list: ReadonlyArray<Trigger>,
  options: { readonly path?: `/${string}` } = {}
): Extension =>
  Layer.effectDiscard(Effect.gen(function*() {
    const router = yield* HttpRouter.HttpRouter
    const sessions = yield* Sessions
    const byName = new Map(list.map((trigger) => [trigger.name, trigger]))
    const path = options.path ?? "/v1/triggers"

    const deliver = Effect.fnUntraced(function*(event: TriggerEvent) {
      const { binding } = yield* sessions.forKey(event.key, event)
      yield* sessions.command(binding.sessionId, {
        _tag: "Prompt",
        content: event.content,
        requestId: event.requestId,
        whenBusy: event.whenBusy ?? "followUp"
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Trigger event was not delivered", { key: event.key, error: error._tag })
        ),
        Effect.forkDetach
      )
      return binding.sessionId
    })

    yield* router.add("POST", `${path}/:name`, Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const { name } = yield* HttpRouter.params
      const trigger = byName.get(name ?? "")
      if (trigger === undefined) return HttpServerResponse.text("Unknown trigger", { status: 404 })
      const body = yield* Effect.orElseSucceed(request.text, () => "")
      const parsed = yield* trigger.handle({
        headers: request.headers,
        body,
        url: new URL(request.url, "http://localhost")
      }).pipe(Effect.result)
      if (parsed._tag === "Failure") {
        return HttpServerResponse.text(parsed.failure.message, { status: parsed.failure.status })
      }
      return yield* Effect.forEach(parsed.success, deliver).pipe(
        Effect.flatMap((sessionIds) => HttpServerResponse.json({ accepted: parsed.success.length, sessions: sessionIds }, { status: 202 })),
        Effect.catchTag("SpecRejected", (error) => Effect.succeed(HttpServerResponse.text(error.message, { status: 400 })))
      )
    }).pipe(Effect.orDie))
  }))
