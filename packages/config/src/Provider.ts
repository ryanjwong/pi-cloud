import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect"
import { SETTINGS } from "./Settings.ts"

export const secretsDirectory = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  env.PI_CLOUD_SECRETS_DIR ?? env.CREDENTIALS_DIRECTORY

export const layer: Layer.Layer<never, never, FileSystem.FileSystem | Path.Path> = ConfigProvider.layer(
  Effect.gen(function*() {
    const env = ConfigProvider.fromEnv()
    const directory = secretsDirectory()
    if (directory === undefined) return env
    return ConfigProvider.orElse(env, yield* ConfigProvider.fromDir({ rootPath: directory }))
  })
)

export interface SettingStatus {
  readonly name: string
  readonly secret: boolean
  readonly components: ReadonlyArray<string>
  readonly description: string
  readonly default?: string | undefined
  readonly source: "environment" | "secrets directory" | undefined
}

export const status = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = secretsDirectory()
  return yield* Effect.forEach(SETTINGS, (setting) =>
    Effect.gen(function*() {
      const inEnv = process.env[setting.name] !== undefined && process.env[setting.name] !== ""
      const inDirectory = !inEnv && directory !== undefined &&
        (yield* fs.exists(path.join(directory, setting.name)).pipe(Effect.orElseSucceed(() => false)))
      return {
        ...setting,
        source: inEnv ? "environment" : inDirectory ? "secrets directory" : undefined
      } satisfies SettingStatus
    }))
})
