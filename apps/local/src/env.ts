import { NodeServices } from "@effect/platform-node"
import { ConfigSource } from "@pi-cloud/config"
import { type Config, Effect } from "effect"

/**
 * Read a config schema the way every Node entry point does: environment variables first, then the secrets
 * directory. A missing or malformed value stops startup with an error naming it.
 */
export const load = <A>(config: Config.Config<A>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function*() {
      return yield* config
    }).pipe(
      Effect.catchTag("ConfigError", (error) =>
        Effect.sync(() => {
          const issue = error.cause as { issue?: { path?: ReadonlyArray<unknown> }; message?: string }
          const key = issue.issue?.path?.join(".") ?? "unknown"
          console.error(`Configuration error: ${key} is missing or invalid (${issue.message?.split("\n")[0] ?? error.message})`)
          console.error("Run pi-cloud-config to see which settings are set.")
          process.exit(1)
        })
      ),
      Effect.provide(ConfigSource.layer),
      Effect.provide(NodeServices.layer)
    )
  )
