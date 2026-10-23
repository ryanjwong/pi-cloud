import { Context, Data, Effect, Layer } from "effect"

export class RepositoryRefused extends Data.TaggedError("RepositoryRefused")<{ readonly reason: string }> {}

export class RepositoryAccess extends Context.Service<RepositoryAccess, {
  check(repository: string): Effect.Effect<void, RepositoryRefused>
}>()("@pi-cloud/core/RepositoryAccess") {
  static readonly make = (check: (repository: string) => Promise<string | undefined>): Layer.Layer<RepositoryAccess> =>
    Layer.succeed(RepositoryAccess, {
      check: (repository) =>
        Effect.tryPromise({
          try: () => check(repository),
          catch: (cause) => new RepositoryRefused({ reason: `could not check ${repository}: ${cause instanceof Error ? cause.message : String(cause)}` })
        }).pipe(Effect.flatMap((reason) => reason === undefined ? Effect.void : Effect.fail(new RepositoryRefused({ reason }))))
    })

  static readonly none: Layer.Layer<RepositoryAccess> = RepositoryAccess.make(async (repository) =>
    `this server has no GitHub access configured to check ${repository}`
  )
}
