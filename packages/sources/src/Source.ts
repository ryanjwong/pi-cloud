import type { JsonValue } from "@earendil-works/chord"
import type { Extension } from "@pi-cloud/control-plane"
import { Sessions } from "@pi-cloud/control-plane"
import { type Binding, BindingStore } from "@pi-cloud/core"
import type { SessionSpec, UserContent, WhenBusy } from "@pi-cloud/protocol"
import type { TriggerRejected, TriggerRequest } from "@pi-cloud/triggers"
import { Effect, Fiber, Layer, Schedule, Schema, Stream } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

/** A message that arrived through a source, addressed to the session bound to `key`. */
export interface InboundMessage {
  /** Stable identity of the conversation outside, e.g. a Slack thread. Same key, same session. */
  readonly key: string
  readonly content: UserContent
  /** Where replies go, in the source's own terms (channel, thread, ...). Stored on the binding. */
  readonly target: JsonValue
  /** Deduplicates redelivered messages. */
  readonly requestId?: string | undefined
  /** Title and spec for the session, used only when the key has no session yet. */
  readonly title?: string | undefined
  readonly spec?: SessionSpec | undefined
  readonly whenBusy?: WhenBusy | undefined
  /** Only deliver if the key already has a session, e.g. an unaddressed reply in a thread the agent is in. */
  readonly onlyIfBound?: boolean | undefined
}

/** What `receive` makes of one inbound request. */
export interface Received {
  readonly messages: ReadonlyArray<InboundMessage>
  /** Replaces the default `200 ok` response, e.g. to answer a URL-verification challenge. */
  readonly response?: { readonly status?: number; readonly json: unknown } | undefined
}

/** An assistant message to send back out. */
export interface Reply {
  readonly sessionId: string
  readonly entryId: number
  readonly text: string
}

export class DeliveryFailed extends Schema.TaggedError<DeliveryFailed>()("DeliveryFailed", {
  message: Schema.String
}) {}

/**
 * A two-way connection: chat platforms, issue trackers, anything people talk to the agent through. `receive`
 * turns inbound requests into messages; `deliver` sends the agent's replies back to a binding's target.
 */
export interface Source {
  readonly name: string
  readonly receive: (request: TriggerRequest) => Effect.Effect<Received, TriggerRejected>
  readonly deliver: (target: JsonValue, reply: Reply) => Effect.Effect<void, DeliveryFailed>
}

export const defineSource = (source: Source): Source => source

type Event = { readonly type: string; readonly [key: string]: any }

const textOf = (entry: any): string =>
  ((entry?.model ?? []) as ReadonlyArray<{ content?: unknown }>)
    .flatMap((message) =>
      typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
        ? message.content.filter((block: any) => block?.type === "text").map((block: any) => String(block.text))
        : []
    )
    .join("")

/** Assistant entries newly visible in one event, oldest first. */
const assistantEntries = (event: Event): ReadonlyArray<any> => {
  if (event.type === "message_end" && event.entry?.kind === "pi.assistant") return [event.entry]
  if (event.type === "snapshot") return (event.entries ?? []).filter((entry: any) => entry?.kind === "pi.assistant")
  return []
}

/**
 * Mount sources at `POST {path}/{name}` and deliver replies. Every binding a source owns gets a follower that
 * watches its session and sends each new assistant message with text through `deliver`, once: the newest
 * delivered entry is recorded on the binding, so a restart picks up where it stopped.
 */
export const sources = (
  list: ReadonlyArray<Source>,
  options: { readonly path?: `/${string}` } = {}
): Extension =>
  Layer.effectDiscard(Effect.gen(function*() {
    const router = yield* HttpRouter.HttpRouter
    const sessions = yield* Sessions
    const bindings = yield* BindingStore
    const byName = new Map(list.map((source) => [source.name, source]))
    const path = options.path ?? "/v1/sources"
    const followers = new Map<string, Fiber.Fiber<void>>()

    const follow = Effect.fnUntraced(function*(initial: Binding, source: Source) {
      if (followers.has(initial.key)) return
      let binding = initial
      const send = (entry: any) =>
        Effect.gen(function*() {
          if (typeof entry.id !== "number" || entry.id <= (binding.delivered ?? 0)) return
          const text = textOf(entry)
          if (text.trim() !== "") {
            yield* source.deliver(binding.target ?? null, { sessionId: binding.sessionId, entryId: entry.id, text }).pipe(
              Effect.retry({ schedule: Schedule.exponential(500), times: 3 }),
              Effect.catch((error) =>
                Effect.logWarning("Reply delivery failed", { key: binding.key, source: source.name, error: error.message })
              )
            )
          }
          binding = { ...binding, delivered: entry.id }
          yield* bindings.put(binding).pipe(Effect.ignore)
        })
      const fiber = yield* sessions.events(binding.sessionId, undefined).pipe(
        Effect.flatMap((events) =>
          events.pipe(
            Stream.flatMap((batch) => Stream.fromIterable(batch.events as ReadonlyArray<Event>)),
            Stream.runForEach((event) => Effect.forEach(assistantEntries(event), send, { discard: true }))
          )
        ),
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => followers.delete(initial.key))),
        Effect.forkDetach
      )
      followers.set(initial.key, fiber)
    })

    // Resume following every binding these sources own.
    for (const source of list) {
      for (const binding of yield* bindings.list(source.name).pipe(Effect.orDie)) yield* follow(binding, source)
    }

    const accept = Effect.fnUntraced(function*(source: Source, message: InboundMessage) {
      if (message.onlyIfBound === true) {
        const existing = yield* bindings.get(message.key).pipe(Effect.orDie)
        if (existing._tag === "None") return undefined
      }
      const { binding } = yield* sessions.forKey(message.key, {
        title: message.title,
        spec: message.spec,
        source: source.name,
        target: message.target
      })
      yield* follow(binding, source)
      yield* sessions.command(binding.sessionId, {
        _tag: "Prompt",
        content: message.content,
        requestId: message.requestId,
        whenBusy: message.whenBusy ?? "followUp"
      }).pipe(
        Effect.catch((error) => Effect.logWarning("Inbound message was not delivered", { key: message.key, error: error._tag })),
        Effect.forkDetach
      )
      return binding.sessionId
    })

    yield* router.add("POST", `${path}/:name`, Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const { name } = yield* HttpRouter.params
      const source = byName.get(name ?? "")
      if (source === undefined) return HttpServerResponse.text("Unknown source", { status: 404 })
      const body = yield* Effect.orElseSucceed(request.text, () => "")
      const received = yield* source.receive({
        headers: request.headers,
        body,
        url: new URL(request.url, "http://localhost")
      }).pipe(Effect.result)
      if (received._tag === "Failure") {
        return HttpServerResponse.text(received.failure.message, { status: received.failure.status })
      }
      yield* Effect.forEach(received.success.messages, (message) => accept(source, message))
      const response = received.success.response
      return yield* HttpServerResponse.json(response?.json ?? { ok: true }, { status: response?.status ?? 200 })
    }).pipe(Effect.orDie))
  }))
