import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect"
import { SETTINGS } from "./Settings.ts"

/**
 * The directory secret files are read from: `PI_CLOUD_SECRETS_DIR`, or systemd's `CREDENTIALS_DIRECTORY` when the
 * service uses `LoadCredential=`. Each file is named after its setting (`/run/secrets/ANTHROPIC_API_KEY`), which
 * is also how sops-nix and container secret mounts lay them out.
 */
export const secretsDirectory = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  env.PI_CLOUD_SECRETS_DIR ?? env.CREDENTIALS_DIRECTORY

/**
 * The config provider of every Node entry point: environment variables first, then the secrets directory. In
 * development, `sops exec-env secrets.yaml '...'` fills the environment; on a server, sops-nix fills the directory.
 */
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
  /** Where the value comes from, or `undefined` when it is not set. */
  readonly source: "environment" | "secrets directory" | undefined
}

/** Which settings are set and where from. Never reads out values. */
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
