import { ApiAuth, secretsEqual, Unauthorized } from "@pi-cloud/protocol"
import { Context, Effect, Layer, Redacted } from "effect"

export class RunnerAuth extends Context.Service<RunnerAuth, {
  check(headers: Readonly<Record<string, string | undefined>>): Effect.Effect<void, Unauthorized>
}>()("@pi-cloud/control-plane/RunnerAuth") {
  static readonly sharedSecret = (secret: string | undefined): Layer.Layer<RunnerAuth> =>
    Layer.succeed(RunnerAuth, {
      check: (headers) =>
        secret === undefined || secretsEqual(headers["authorization"] ?? "", `Bearer ${secret}`)
          ? Effect.void
          : Effect.fail(new Unauthorized({ message: "Invalid runner credentials" }))
    })
}

export class ClientAuth extends Context.Service<ClientAuth, {
  check(token: string | undefined): Effect.Effect<void, Unauthorized>
}>()("@pi-cloud/control-plane/ClientAuth") {
  static readonly apiKeys = (keys: ReadonlyArray<string> | undefined): Layer.Layer<ClientAuth> =>
    Layer.succeed(ClientAuth, {
      check: (token) =>
        keys === undefined || keys.length === 0 ||
          (token !== undefined && keys.reduce((matched, key) => secretsEqual(token, key) || matched, false))
          ? Effect.void
          : Effect.fail(new Unauthorized({ message: "Missing or invalid API key" }))
    })
}

export const ApiAuthLive: Layer.Layer<ApiAuth, never, ClientAuth> = Layer.effect(
  ApiAuth,
  Effect.gen(function*() {
    const auth = yield* ClientAuth
    return ApiAuth.of({
      bearer: (httpEffect, { credential }) => Effect.andThen(auth.check(Redacted.value(credential)), httpEffect)
    })
  })
)
