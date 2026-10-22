import { type Session, StorageFailure } from "@pi-cloud/protocol"
import { Context, Effect, Layer, Option } from "effect"

export interface IssuedSecret {
  readonly value: string
  readonly expiresAt?: number
}

export class SessionSecrets extends Context.Service<SessionSecrets, {
  issue(session: Session, name: string): Effect.Effect<Option.Option<IssuedSecret>, StorageFailure>
}>()("@pi-cloud/core/SessionSecrets") {
  static readonly none: Layer.Layer<SessionSecrets> = Layer.succeed(SessionSecrets, {
    issue: () => Effect.succeed(Option.none())
  })

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
          catch: (cause) => new StorageFailure({ message: `Could not issue ${name}: ${cause instanceof Error ? cause.message : String(cause)}` })
        })
    })
}
