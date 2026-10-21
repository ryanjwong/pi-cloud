import { type Session, StorageFailure } from "@pi-cloud/protocol"
import { Context, Effect, Layer, Option } from "effect"

/** A secret issued to one session, valid until `expiresAt` (epoch ms) when it has one. */
export interface IssuedSecret {
  readonly value: string
  readonly expiresAt?: number
}

/**
 * Secrets the control plane issues to sessions on request, by name: short-lived and scoped to what the session is
 * about (a GitHub App installation token for the session's repository, for instance). Runners ask through the
 * lease-checked runner RPC and fall back to their own secrets when the control plane has none.
 */
export class SessionSecrets extends Context.Service<SessionSecrets, {
  issue(session: Session, name: string): Effect.Effect<Option.Option<IssuedSecret>, StorageFailure>
}>()("@pi-cloud/core/SessionSecrets") {
  /** Issues nothing: runners use their own secrets. */
  static readonly none: Layer.Layer<SessionSecrets> = Layer.succeed(SessionSecrets, {
    issue: () => Effect.succeed(Option.none())
  })

  /** The first issuer that has the secret wins. */
  static readonly issuers = (
    ...issuers: ReadonlyArray<(session: Session, name: string) => Promise<IssuedSecret | undefined>>
  ): Layer.Layer<SessionSecrets> =>
    Layer.succeed(SessionSecrets, {
      issue: (session, name) =>
        Effect.tryPromise({
          try: async () => {
            for (const issuer of issuers) {
              const issued = await issuer(session, name)
              if (issued !== undefined) return Option.some(issued)
            }
            return Option.none<IssuedSecret>()
          },
          // Reported to the runner, which fails the one lookup rather than falling back to a broader secret.
          catch: (cause) => new StorageFailure({ message: `Could not issue ${name}: ${cause instanceof Error ? cause.message : String(cause)}` })
        })
    })
}
