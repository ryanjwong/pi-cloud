import { DispatchFailed, RunnerDispatcher } from "@pi-cloud/core"
import { RUNNER_WAKE_PATH } from "@pi-cloud/protocol"
import { Effect, Layer } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { guarded, RunnerAuth } from "./Auth.ts"

export const pullDispatcher: Layer.Layer<RunnerDispatcher, never, HttpRouter.HttpRouter | RunnerAuth> = Layer.effect(
  RunnerDispatcher,
  Effect.gen(function*() {
    const router = yield* HttpRouter.HttpRouter
    const auth = yield* RunnerAuth
    const hosts: Array<(text: string) => Effect.Effect<void, unknown>> = []
    let next = 0

    yield* router.add("GET", RUNNER_WAKE_PATH, guarded(auth.check, () => Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const socket = yield* Effect.orDie(request.upgrade)
      const writer = yield* socket.writer
      const reader = yield* socket.reader
      const send = (text: string) => writer.write(text)
      hosts.push(send)
      yield* reader.pull.pipe(
        Effect.forever,
        Effect.ignore,
        Effect.ensuring(Effect.sync(() => void hosts.splice(hosts.indexOf(send), 1)))
      )
      return HttpServerResponse.empty()
    }).pipe(Effect.orDie)))

    return RunnerDispatcher.of({
      wake: (request) => {
        const send = hosts[next++ % Math.max(1, hosts.length)]
        const failed = (message: string) => new DispatchFailed({ sessionId: request.sessionId, message })
        return send === undefined
          ? Effect.fail(failed("No runner host is connected"))
          : send(JSON.stringify(request)).pipe(Effect.mapError(() => failed("The runner host connection dropped")))
      }
    })
  })
)
