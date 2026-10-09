import type { Extension } from "@pi-cloud/control-plane"
import { Sessions } from "@pi-cloud/control-plane"
import type { SessionSpec, UserContent, WhenBusy } from "@pi-cloud/protocol"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

/** Something that happened outside, addressed to the session bound to `key`. */
export interface TriggerEvent {
  /** Stable identity of the thing the event is about, e.g. `github:acme/api#42`. Same key, same session. */
  readonly key: string
  /** What the agent is told. */
  readonly content: UserContent
  /** Deduplicates redelivered events: a repeat with the same id is not submitted twice. */
  readonly requestId?: string | undefined
  /** Title and spec for the session, used only when the key has no session yet. */
  readonly title?: string | undefined
  readonly spec?: SessionSpec | undefined
  /** What to do when the session is busy. Defaults to a follow-up after the current run. */
  readonly whenBusy?: WhenBusy | undefined
}

/** The inbound request, reduced to what verification and parsing need. */
export interface TriggerRequest {
  readonly headers: Readonly<Record<string, string | undefined>>
  readonly body: string
  readonly url: URL
}

export class TriggerRejected extends Schema.TaggedError<TriggerRejected>()("TriggerRejected", {
  status: Schema.Number,
  message: Schema.String
}) {}

/**
 * A one-way event source: it verifies an inbound request and turns it into events. Triggers never reply; an agent
 * that needs to answer uses a tool (comment on the pull request, update the ticket, ...).
 */
export interface Trigger {
  readonly name: string
  readonly handle: (request: TriggerRequest) => Effect.Effect<ReadonlyArray<TriggerEvent>, TriggerRejected>
}

export const defineTrigger = (trigger: Trigger): Trigger => trigger

/**
 * Mount triggers at `POST {path}/{name}`. Each event goes to the session bound to its key (created on first
 * use) as a prompt. The response returns once sessions are resolved; prompts are delivered in the background, so
 * senders with short timeouts (GitHub, Slack) are answered at once even if a runner has to start.
 */
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
      const { binding } = yield* sessions.forKey(event.key, { title: event.title, spec: event.spec })
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
      const sessionIds = yield* Effect.forEach(parsed.success, deliver)
      return yield* HttpServerResponse.json({ accepted: parsed.success.length, sessions: sessionIds }, { status: 202 })
    }).pipe(Effect.orDie))
  }))
