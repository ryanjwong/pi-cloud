import { ApiAuth, Unauthorized } from "@pi-cloud/protocol"
import { Context, Effect, Layer, Redacted } from "effect"

/** Authenticates runners calling the internal RPC. */
export class RunnerAuth extends Context.Service<RunnerAuth, {
  check(headers: Readonly<Record<string, string | undefined>>): Effect.Effect<void, Unauthorized>
}>()("@pi-cloud/control-plane/RunnerAuth") {
  /** Runners must send `Authorization: Bearer <secret>`. Without a secret, every runner is accepted. */
  static readonly sharedSecret = (secret: string | undefined): Layer.Layer<RunnerAuth> =>
    Layer.succeed(RunnerAuth, {
      check: (headers) =>
        secret === undefined || headers["authorization"] === `Bearer ${secret}`
          ? Effect.void
          : Effect.fail(new Unauthorized({ message: "Invalid runner credentials" }))
    })
}

/**
 * Authenticates public clients by bearer token. Every public surface (the REST API and the session channel)
 * checks through this one service, so swapping it changes authentication everywhere.
 */
export class ClientAuth extends Context.Service<ClientAuth, {
  check(token: string | undefined): Effect.Effect<void, Unauthorized>
}>()("@pi-cloud/control-plane/ClientAuth") {
  /** Accept these API keys. Without keys, every request is accepted (development only). */
  static readonly apiKeys = (keys: ReadonlyArray<string> | undefined): Layer.Layer<ClientAuth> =>
    Layer.succeed(ClientAuth, {
      check: (token) =>
        keys === undefined || keys.length === 0 || (token !== undefined && keys.includes(token))
          ? Effect.void
          : Effect.fail(new Unauthorized({ message: "Missing or invalid API key" }))
    })
}

/** The `PublicApi` bearer middleware, backed by `ClientAuth`. */
export const ApiAuthLive: Layer.Layer<ApiAuth, never, ClientAuth> = Layer.effect(
  ApiAuth,
  Effect.gen(function*() {
    const auth = yield* ClientAuth
    return ApiAuth.of({
      bearer: (httpEffect, { credential }) => Effect.andThen(auth.check(Redacted.value(credential)), httpEffect)
    })
  })
)
