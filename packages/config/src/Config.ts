import { Config, Option, Redacted } from "effect"
import { MODEL_CREDENTIALS } from "./Settings.ts"

const names = (name: string) =>
  Config.String(name).pipe(
    Config.map((value) => value.split(",").map((item) => item.trim()).filter((item) => item !== "")),
    Config.withDefault<ReadonlyArray<string>>([])
  )

const secretList = (name: string) =>
  Config.Redacted(name).pipe(
    Config.map((value) => Redacted.value(value).split(",").map((item) => item.trim()).filter(Boolean).map((item) => Redacted.make(item))),
    Config.withDefault<ReadonlyArray<Redacted.Redacted<string>>>([])
  )

/** Settings of the control plane. */
export const ControlPlaneEnv = Config.all({
  port: Config.Port("PORT").pipe(Config.withDefault(8787)),
  host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
  dataDir: Config.String("DATA_DIR").pipe(Config.withDefault(".data")),
  publicUrl: Config.option(Config.String("PUBLIC_URL")),
  runnerUrl: Config.option(Config.String("RUNNER_URL")),
  apiKeys: secretList("PI_CLOUD_API_KEYS"),
  runnerSecret: Config.option(Config.Redacted("PI_CLOUD_RUNNER_SECRET")),
  model: Config.String("PI_CLOUD_MODEL").pipe(Config.withDefault("anthropic/claude-opus-5-5")),
  github: Config.option(Config.all({
    webhookSecret: Config.Redacted("GITHUB_WEBHOOK_SECRET"),
    mention: Config.option(Config.String("GITHUB_MENTION")),
    sandboxProvider: Config.String("GITHUB_SANDBOX_PROVIDER").pipe(Config.withDefault("local"))
  })),
  slack: Config.option(Config.all({
    signingSecret: Config.Redacted("SLACK_SIGNING_SECRET"),
    botToken: Config.Redacted("SLACK_BOT_TOKEN")
  }))
})
export type ControlPlaneEnv = Config.Success<typeof ControlPlaneEnv>

/** Model provider keys, by the name pi-ai looks them up under. */
export const ModelCredentials = Config.all(
  Object.fromEntries(MODEL_CREDENTIALS.map((name) => [name, Config.option(Config.Redacted(name))]))
) as Config.Config<Record<string, Option.Option<Redacted.Redacted<string>>>>

/**
 * Settings of a runner hosted on Cloudflare. The Worker loads this at startup, which makes Alchemy bind every key
 * in it to the Worker (secrets as encrypted Worker secrets) from the deploy environment.
 */
export const WorkerRunnerEnv = Config.all({
  controlPlaneUrl: Config.String("CONTROL_PLANE_URL"),
  runnerSecret: Config.Redacted("PI_CLOUD_RUNNER_SECRET"),
  modelCredentials: ModelCredentials
})
export type WorkerRunnerEnv = Config.Success<typeof WorkerRunnerEnv>

/** Settings of a runner host. */
export const RunnerEnv = Config.all({
  port: Config.Port("PORT").pipe(Config.withDefault(8788)),
  host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
  dataDir: Config.String("DATA_DIR").pipe(Config.withDefault(".data")),
  controlPlaneUrl: Config.option(Config.String("CONTROL_PLANE_URL")),
  runnerSecret: Config.option(Config.Redacted("PI_CLOUD_RUNNER_SECRET")),
  modelCredentials: ModelCredentials,
  githubToken: Config.option(Config.Redacted("GITHUB_TOKEN")),
  templatesFile: Config.option(Config.String("SANDBOX_TEMPLATES_FILE")),
  /**
   * Secrets sandbox templates may request: each name listed in `SANDBOX_SECRETS`, read like any other secret.
   * A listed secret that cannot be read is a startup error; an unlisted one can never reach a sandbox.
   */
  sandboxSecrets: names("SANDBOX_SECRETS").pipe(
    Config.flatMap((list) =>
      Config.all(Object.fromEntries(list.map((name) => [name, Config.Redacted(name)]))) as Config.Config<
        Record<string, Redacted.Redacted<string>>
      >
    )
  )
})
export type RunnerEnv = Config.Success<typeof RunnerEnv>

/** Look up a model credential by name, for `SessionRunnerOptions.modelCredentials`. */
export const modelCredentialLookup = (env: Pick<RunnerEnv, "modelCredentials">) => (name: string): string | undefined => {
  const value = env.modelCredentials[name]
  return value === undefined ? undefined : Option.match(value, { onNone: () => undefined, onSome: Redacted.value })
}

/** Look up a sandbox secret by name, for `RunnerHostOptions.secrets`. Unlisted names resolve to nothing. */
export const sandboxSecretLookup = (env: RunnerEnv) => async (name: string): Promise<string | undefined> => {
  const value = env.sandboxSecrets[name]
  return value === undefined ? undefined : Redacted.value(value)
}
