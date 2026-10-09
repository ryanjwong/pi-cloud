import { ApiAuth, type EventBatch, PublicApi } from "@pi-cloud/protocol"
import { Context, Effect, Layer, Stream } from "effect"
import { FetchHttpClient, HttpClientRequest } from "effect/http"
import { HttpApiClient, HttpApiMiddleware } from "effect/http-api"

export * from "@pi-cloud/protocol"

export interface ClientOptions {
  /** Base URL of the control plane. */
  readonly url: string
  readonly apiKey?: string
}

/** The typed public API client, derived from `PublicApi`: `client.sessions.create(...)`, `client.sessions.events(...)`. */
export class PiCloud extends Context.Service<PiCloud, HttpApiClient.ForApi<typeof PublicApi>>()(
  "@pi-cloud/client/PiCloud"
) {
  static readonly layer = (options: ClientOptions): Layer.Layer<PiCloud> =>
    Layer.effect(PiCloud, HttpApiClient.make(PublicApi, { baseUrl: options.url })).pipe(
      Layer.provide(
        HttpApiMiddleware.layerClient(ApiAuth, ({ next, request }) =>
          next(HttpClientRequest.bearerToken(request, options.apiKey ?? "anonymous")))
      ),
      Layer.provide(FetchHttpClient.layer)
    )
}

/**
 * Follow a session's events forever: reconnects after drops and resumes from the last batch seen, so consumers
 * get each batch once (a fresh snapshot when the gap could not be bridged).
 */
export const followEvents = (sessionId: string): Stream.Stream<EventBatch, never, PiCloud> =>
  Stream.unwrap(Effect.gen(function*() {
    const client = yield* PiCloud
    let last: { epoch: number; seq: number } | undefined
    const connect: Stream.Stream<EventBatch> = Stream.unwrap(Effect.suspend(() =>
      client.sessions.events({
        params: { id: sessionId as never },
        query: { after: last === undefined ? undefined : `${last.epoch}:${last.seq}` }
      }).pipe(
        Effect.map((stream) =>
          stream.pipe(
            Stream.tap((batch) => Effect.sync(() => void (last = batch))),
            Stream.catchCause(() => Stream.empty)
          )
        ),
        Effect.orElseSucceed(() => Stream.empty)
      )
    ))
    return Stream.concat(connect, Stream.fromEffect(Effect.sleep(1_000)).pipe(Stream.drain)).pipe(Stream.forever)
  }))

/** Collect the text of an assistant message from Pi agent events, as it streams. */
export const textOf = (message: { readonly content?: ReadonlyArray<unknown> } | undefined): string =>
  (message?.content ?? [])
    .map((block) => (block as { type?: string; text?: string }).type === "text" ? (block as { text: string }).text : "")
    .join("")



/** The text of a transcript entry (a Pi `EntryRecord`): its model messages' text blocks, joined. */
export const entryText = (entry: { readonly model?: ReadonlyArray<{ readonly content?: unknown }> } | undefined): string =>
  (entry?.model ?? [])
    .map((message) =>
      typeof message.content === "string" ? message.content : textOf(message as { content?: ReadonlyArray<unknown> })
    )
    .join("")
