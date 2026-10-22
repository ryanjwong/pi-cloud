import type { WakeRequest } from "@pi-cloud/protocol"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

export class DispatchFailed extends Schema.TaggedError<DispatchFailed>()("DispatchFailed", {
  sessionId: Schema.String,
  message: Schema.String
}) {}

export class RunnerDispatcher extends Context.Service<RunnerDispatcher, {
  wake(request: WakeRequest): Effect.Effect<void, DispatchFailed>
}>()("@pi-cloud/control-plane/RunnerDispatcher") {
  static readonly make = (wake: (request: WakeRequest) => Promise<void>): Layer.Layer<RunnerDispatcher> =>
    Layer.succeed(RunnerDispatcher, {
      wake: (request) =>
        Effect.tryPromise({
          try: () => wake(request),
          catch: (cause) => new DispatchFailed({ sessionId: request.sessionId, message: String(cause) })
        })
    })

  static readonly none: Layer.Layer<RunnerDispatcher> = Layer.succeed(RunnerDispatcher, { wake: () => Effect.void })

  static readonly http = (options: { readonly url: string; readonly secret?: string }): Layer.Layer<
    RunnerDispatcher,
    never,
    HttpClient.HttpClient
  > =>
    Layer.effect(
      RunnerDispatcher,
      Effect.gen(function*() {
        const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk)
        return RunnerDispatcher.of({
          wake: (request) => {
            let http = HttpClientRequest.post(options.url).pipe(HttpClientRequest.bodyJsonUnsafe(request))
            if (options.secret !== undefined) http = HttpClientRequest.bearerToken(http, options.secret)
            return client.execute(http).pipe(
              Effect.asVoid,
              Effect.mapError((cause) => new DispatchFailed({ sessionId: request.sessionId, message: cause.message }))
            )
          }
        })
      })
    )
}
