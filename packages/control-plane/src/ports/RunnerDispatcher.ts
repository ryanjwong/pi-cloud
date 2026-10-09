import type { WakeRequest } from "@pi-cloud/protocol"
import { Context, Effect, Layer, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"

export class DispatchFailed extends Schema.TaggedError<DispatchFailed>()("DispatchFailed", {
  sessionId: Schema.String,
  message: Schema.String
}) {}

/**
 * Starts a runner for a session somewhere. This is the only place the control plane meets a substrate: a
 * Durable Object, a container platform, a Modal function, a local process. A woken runner attaches back over the
 * runner RPC; the control plane never needs to reach it again.
 */
export class RunnerDispatcher extends Context.Service<RunnerDispatcher, {
  wake(request: WakeRequest): Effect.Effect<void, DispatchFailed>
}>()("@pi-cloud/control-plane/RunnerDispatcher") {
  /** Dispatch with your own function. */
  static readonly make = (wake: (request: WakeRequest) => Promise<void>): Layer.Layer<RunnerDispatcher> =>
    Layer.succeed(RunnerDispatcher, {
      wake: (request) =>
        Effect.tryPromise({
          try: () => wake(request),
          catch: (cause) => new DispatchFailed({ sessionId: request.sessionId, message: String(cause) })
        })
    })

  /** Never starts runners: they must attach on their own, e.g. a fixed pool. */
  static readonly none: Layer.Layer<RunnerDispatcher> = Layer.succeed(RunnerDispatcher, { wake: () => Effect.void })

  /**
   * POST the wake request as JSON to a runner host, e.g. a Worker fronting Durable Objects or an HTTP endpoint
   * on a container platform. `secret` is sent as a bearer token.
   */
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
