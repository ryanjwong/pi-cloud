import type { DurableObjectLocationHint, DurableObjectNamespace } from "@cloudflare/workers-types"
import { CloudflareEnv } from "@pi-cloud/config"
import { ConfigProvider, Effect } from "effect"
import type { ControlPlane } from "./ControlPlane.ts"
import type { SessionHost } from "./SessionHost.ts"

export interface Env {
  readonly CONTROL_PLANE: DurableObjectNamespace<ControlPlane>
  readonly SESSION_HOST: DurableObjectNamespace<SessionHost>
  readonly PI_CLOUD_LOCATION?: DurableObjectLocationHint
  readonly [setting: string]: unknown
}

export const LEGACY_CONTROL_PLANE = "control-plane"

export const CONTROL_PLANE = "control-plane-2"

export const near = (env: Env) => ({ locationHint: env.PI_CLOUD_LOCATION ?? "wnam" })

export const controlPlane = (env: Env) => env.CONTROL_PLANE.getByName(CONTROL_PLANE, near(env))

export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`

export const schema = (sql: SqlStorage) =>
  sql.exec<{ type: string; name: string; sql: string }>(
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND tbl_name NOT GLOB 'sqlite_*' AND tbl_name NOT GLOB '_*' ORDER BY type = 'table' DESC, rowid"
  ).toArray()

export const wipe = (sql: SqlStorage) => {
  for (const { type, name } of schema(sql)) if (type === "table") sql.exec(`DROP TABLE IF EXISTS ${quote(name)}`)
}

export const INTERNAL_URL = "https://control-plane.internal"

export class NotConfigured extends Error {}

export const settings = async (env: Env): Promise<CloudflareEnv> => {
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      return yield* CloudflareEnv
    }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(
        Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      ))),
      Effect.result
    )
  )
  if (result._tag === "Failure" || (result.success.apiKeys.length === 0 && (result.success.auth.keys ?? []).length === 0) || result.success.credentialKeys.length === 0) {
    if (result._tag === "Failure") console.error(result.failure.message)
    throw new NotConfigured(
      "pi-cloud is not configured: set the secrets PI_CLOUD_RUNNER_SECRET, PI_CLOUD_CREDENTIAL_KEY and PI_CLOUD_API_KEYS or auth.keys in PI_CLOUD_CONFIG (wrangler secret put); details are in the Worker logs"
    )
  }
  return result.success
}
