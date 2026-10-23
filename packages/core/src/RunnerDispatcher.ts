import type { WakeRequest } from "@pi-cloud/protocol"
import { Context, Effect, Layer, Schema } from "effect"

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
}
