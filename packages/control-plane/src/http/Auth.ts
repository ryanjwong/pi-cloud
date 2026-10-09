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

/** Public API keys. Without keys, every request is accepted (development only). */
export const apiKeys = (keys: ReadonlyArray<string> | undefined): Layer.Layer<ApiAuth> =>
  Layer.succeed(
    ApiAuth,
    ApiAuth.of({
      bearer: (httpEffect, { credential }) =>
        keys === undefined || keys.length === 0 || keys.includes(Redacted.value(credential))
          ? httpEffect
          : Effect.fail(new Unauthorized({ message: "Missing or invalid API key" }))
    })
  )
