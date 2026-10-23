import { NodeServices } from "@effect/platform-node"
import { ConfigSource, type ControlPlaneEnv } from "@pi-cloud/config"
import { type Config, Effect } from "effect"

export const keyed = (env: ControlPlaneEnv) => env.apiKeys.length > 0 || (env.auth.keys ?? []).length > 0

export const load = <A>(config: Config.Config<A>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      return yield* config
    }).pipe(
      Effect.catchTag("ConfigError", (error) =>
        Effect.sync(() => {
          const issue = error.cause as { issue?: { path?: ReadonlyArray<unknown> }; message?: string }
          const key = issue.issue?.path?.join(".")
          console.error(key === undefined
            ? `Configuration error: ${issue.message ?? error.message}`
            : `Configuration error: ${key} is missing or invalid (${issue.message?.split("\n")[0] ?? error.message})`)
          console.error("Run pi-cloud-config to see which settings are set.")
          process.exit(1)
        })
      ),
      Effect.provide(ConfigSource.layer),
      Effect.provide(NodeServices.layer)
    )
  )
