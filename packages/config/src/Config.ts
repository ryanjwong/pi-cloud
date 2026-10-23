import type { SandboxTemplate } from "@pi-cloud/protocol"
import { Config, Effect, Option, Redacted } from "effect"
import { configError, readConfigFile, SandboxTemplates, type ServerConfig, serverConfig } from "./ServerConfig.ts"
import { MODEL_CREDENTIALS } from "./Settings.ts"

const DEFAULT_MODEL = "anthropic/claude-opus-5-5"
const SANDBOX_USER = "1000:1000"

const names = (name: string, fallback: ReadonlyArray<string> = []) =>
  Config.String(name).pipe(
    Config.map((value) => value.split(",").map((item) => item.trim()).filter((item) => item !== "")),
    Config.withDefault<ReadonlyArray<string>>(fallback)
  )

const credentials = (list: ReadonlyArray<string>) =>
  Config.all(Object.fromEntries(list.map((name) => [name, Config.option(Config.Redacted(name))]))) as Config.Config<
    Record<string, Option.Option<Redacted.Redacted<string>>>
  >

const unsafeLocalSandbox = (config: ServerConfig) =>
  Config.Boolean("PI_CLOUD_UNSAFE_LOCAL_SANDBOX").pipe(Config.withDefault(config.unsafeLocalSandbox ?? false))

const settingsOf = (
  config: ServerConfig,
  templates: Readonly<Record<string, SandboxTemplate>>,
  defaultModel: string | undefined,
  required: ReadonlyArray<readonly [string, string]> = []
) => {
  const defaultSandbox = config.sandbox?.default ?? "scratch"
  const missing = [["sandbox.default", defaultSandbox] as const, ...required].find(([, name]) => !Object.hasOwn(templates, name))
  return Effect.as(
    missing === undefined ? Effect.void : Effect.fail(configError(`PI_CLOUD_CONFIG: ${missing[0]} names no sandbox template ("${missing[1]}")`)),
    { templates, defaultSandbox, defaultModel }
  )
}

const secretList = (name: string) =>
  Config.Redacted(name).pipe(
    Config.map((value) => Redacted.value(value).split(",").map((item) => item.trim()).filter(Boolean).map((item) => Redacted.make(item))),
    Config.withDefault<ReadonlyArray<Redacted.Redacted<string>>>([])
  )

const model = (config: ServerConfig) => Config.String("PI_CLOUD_MODEL").pipe(Config.withDefault(config.models?.default ?? DEFAULT_MODEL))

const githubApp = Config.option(Config.all({
  appId: Config.String("GITHUB_APP_ID"),
  privateKey: Config.Redacted("GITHUB_APP_PRIVATE_KEY")
}))

const github = (config: ServerConfig, sandboxProvider: string) =>
  Config.option(Config.all({
    webhookSecret: Config.Redacted("GITHUB_WEBHOOK_SECRET"),
    mention: Config.String("GITHUB_MENTION").pipe(Config.withDefault(config.triggers?.github?.mention)),
    sandboxProvider: Config.String("GITHUB_SANDBOX_PROVIDER").pipe(Config.withDefault(sandboxProvider)),
    allowedAssociations: names("GITHUB_ALLOWED_ASSOCIATIONS", config.triggers?.github?.allowedAssociations ?? ["OWNER", "MEMBER", "COLLABORATOR"]),
    template: Config.succeed(config.triggers?.github?.template ?? "github")
  }))

const builtIn = (
  scratch: SandboxTemplate,
  env: { readonly githubApp: Option.Option<unknown>; readonly github: Option.Option<{ readonly sandboxProvider: string }> }
): Record<string, SandboxTemplate> => {
  const app = Option.isSome(env.githubApp)
  return {
    scratch: { ...scratch, repositories: "installed", allowRef: true, ...(app ? { credential: "GITHUB_TOKEN" } : {}) },
    ...Option.match(env.github, {
      onNone: () => ({}),
      onSome: ({ sandboxProvider }) => ({ github: { provider: sandboxProvider, user: SANDBOX_USER, credential: "GITHUB_TOKEN", ...(app ? { repositories: "installed" } : {}) } })
    })
  }
}

const githubRequired = (trigger: Option.Option<{ readonly template: string }>) =>
  Option.match(trigger, { onNone: () => [], onSome: ({ template }) => [["triggers.github.template", template] as const] })

export const ControlPlaneEnv = serverConfig.pipe(Config.flatMap((config) =>
  Config.all({
    port: Config.Port("PORT").pipe(Config.withDefault(8787)),
    host: Config.String("HOST").pipe(Config.withDefault("127.0.0.1")),
    dataDir: Config.String("DATA_DIR").pipe(Config.withDefault(".data")),
    publicUrl: Config.option(Config.String("PUBLIC_URL")),
    auth: Config.succeed(config.auth ?? {}),
    apiKeys: secretList("PI_CLOUD_API_KEYS"),
    runnerSecret: Config.option(Config.Redacted("PI_CLOUD_RUNNER_SECRET")),
    credentialKeys: secretList("PI_CLOUD_CREDENTIAL_KEY"),
    model: model(config),
    unsafeLocalSandbox: unsafeLocalSandbox(config),
    templatesFile: Config.option(Config.String("SANDBOX_TEMPLATES_FILE")).pipe(
      Config.mapEffect(Option.match({ onNone: () => Effect.succeed({}), onSome: (file) => readConfigFile(SandboxTemplates, "SANDBOX_TEMPLATES_FILE", file) }))
    ),
    githubApp,
    github: github(config, "docker"),
    slack: Config.option(Config.all({
      signingSecret: Config.Redacted("SLACK_SIGNING_SECRET"),
      botToken: Config.Redacted("SLACK_BOT_TOKEN"),
      allowedUsers: names("SLACK_ALLOWED_USERS", config.triggers?.slack?.allowedUsers),
      allowedChannels: names("SLACK_ALLOWED_CHANNELS", config.triggers?.slack?.allowedChannels)
    }))
  }).pipe(Config.mapEffect(({ templatesFile, ...env }) =>
    settingsOf(config, {
      ...builtIn(env.unsafeLocalSandbox ? { provider: "local" } : { provider: "docker", user: SANDBOX_USER }, env),
      ...config.sandbox?.templates,
      ...templatesFile
    }, env.model, githubRequired(env.github)).pipe(
      Effect.map((settings) => ({ ...env, settings }))
    )
  ))
))
export type ControlPlaneEnv = Config.Success<typeof ControlPlaneEnv>

export const CloudflareEnv = serverConfig.pipe(Config.flatMap((config) =>
  Config.all({
    auth: Config.succeed(config.auth ?? {}),
    apiKeys: secretList("PI_CLOUD_API_KEYS"),
    runnerSecret: Config.Redacted("PI_CLOUD_RUNNER_SECRET"),
    credentialKeys: secretList("PI_CLOUD_CREDENTIAL_KEY"),
    modelCredentials: credentials(config.providers ?? MODEL_CREDENTIALS),
    daytonaApiKey: Config.option(Config.Redacted("DAYTONA_API_KEY")),
    model: model(config),
    githubApp,
    github: github(config, "daytona")
  }).pipe(Config.mapEffect((env) =>
    settingsOf(config, { ...builtIn({ provider: "daytona" }, env), ...config.sandbox?.templates }, config.models?.default, githubRequired(env.github)).pipe(
      Effect.map((settings) => ({ ...env, settings }))
    )
  ))
))
export type CloudflareEnv = Config.Success<typeof CloudflareEnv>

export const RunnerEnv = serverConfig.pipe(Config.flatMap((config) =>
  Config.all({
    dataDir: Config.String("DATA_DIR").pipe(Config.withDefault(".data")),
    controlPlaneUrl: Config.option(Config.String("CONTROL_PLANE_URL")),
    runnerSecret: Config.option(Config.Redacted("PI_CLOUD_RUNNER_SECRET")),
    modelCredentials: credentials(config.providers ?? MODEL_CREDENTIALS),
    unsafeLocalSandbox: unsafeLocalSandbox(config),
    daytonaApiKey: Config.option(Config.Redacted("DAYTONA_API_KEY")),
    sandboxSecrets: names("SANDBOX_SECRETS").pipe(
      Config.flatMap((list) =>
        Config.all(Object.fromEntries(list.map((name) => [name, Config.Redacted(name)]))) as Config.Config<
          Record<string, Redacted.Redacted<string>>
        >
      )
    )
  })
))
export type RunnerEnv = Config.Success<typeof RunnerEnv>

export const modelCredentialLookup = (env: Pick<RunnerEnv, "modelCredentials">) => (name: string): string | undefined => {
  const value = env.modelCredentials[name]
  return value === undefined ? undefined : Option.match(value, { onNone: () => undefined, onSome: Redacted.value })
}

export const sandboxSecretLookup = (env: RunnerEnv) => async (name: string): Promise<string | undefined> => {
  const value = env.sandboxSecrets[name]
  return value === undefined ? undefined : Redacted.value(value)
}
