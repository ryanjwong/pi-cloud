import { SandboxTemplate } from "@pi-cloud/protocol"
import { Config, ConfigProvider, Effect, Option, Schema } from "effect"

const Names = Schema.Array(Schema.String)

export const SandboxTemplates = Schema.Record(Schema.String, SandboxTemplate)

export const ServerConfig = Schema.Struct({
  models: Schema.optional(Schema.Struct({ default: Schema.optional(Schema.String) })),
  providers: Schema.optional(Names),
  sandbox: Schema.optional(Schema.Struct({
    default: Schema.optional(Schema.String),
    templates: Schema.optional(SandboxTemplates)
  })),
  triggers: Schema.optional(Schema.Struct({
    github: Schema.optional(Schema.Struct({
      allowedAssociations: Schema.optional(Names),
      mention: Schema.optional(Schema.String),
      template: Schema.optional(Schema.String)
    })),
    slack: Schema.optional(Schema.Struct({
      allowedUsers: Schema.optional(Names),
      allowedChannels: Schema.optional(Names)
    }))
  })),
  unsafeLocalSandbox: Schema.optional(Schema.Boolean)
})
export type ServerConfig = typeof ServerConfig.Type

export const defineConfig = (config: ServerConfig): ServerConfig => config

export const configError = (message: string, cause?: unknown) =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message, cause }))

export const readConfigFile = <A>(schema: Schema.Decoder<A>, name: string, source: string): Effect.Effect<A, Config.ConfigError> => {
  const inline = source.trimStart().startsWith("{")
  const label = inline ? name : source
  return Effect.tryPromise({
    try: async (): Promise<unknown> => {
      if (inline) return JSON.parse(source)
      if (source.endsWith(".json")) return JSON.parse(await (await import("node:fs/promises")).readFile(source, "utf8"))
      const { resolve } = await import("node:path")
      return (await import((await import("node:url")).pathToFileURL(resolve(source)).href)).default
    },
    catch: (cause) => configError(`Cannot read ${label}: ${cause instanceof Error ? cause.message : String(cause)}`, cause)
  }).pipe(
    Effect.flatMap((raw) => Schema.decodeUnknownEffect(schema)(raw, { onExcessProperty: "error" })),
    Effect.mapError((error) =>
      Schema.isSchemaError(error) ? configError(`${label}: ${error.message.replace(/\s*\n\s*/g, " ")}`, error) : error
    )
  )
}

export const serverConfig: Config.Config<ServerConfig> = Config.option(Config.String("PI_CLOUD_CONFIG")).pipe(
  Config.mapEffect(Option.match({ onNone: () => Effect.succeed({}), onSome: (source) => readConfigFile(ServerConfig, "PI_CLOUD_CONFIG", source) }))
)
