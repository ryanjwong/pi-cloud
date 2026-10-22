import type { DurableObjectNamespace } from "@cloudflare/workers-types"
import { CloudflareEnv } from "@pi-cloud/config"
import { ConfigProvider, Effect } from "effect"
import type { ControlPlane } from "./ControlPlane.ts"
import type { SessionHost } from "./SessionHost.ts"

export interface Env {
  readonly CONTROL_PLANE: DurableObjectNamespace<ControlPlane>
  readonly SESSION_HOST: DurableObjectNamespace<SessionHost>
  readonly [setting: string]: unknown
}

export const CONTROL_PLANE = "control-plane"

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
  if (result._tag === "Failure" || result.success.apiKeys.length === 0) {
    if (result._tag === "Failure") console.error(result.failure.message)
    throw new NotConfigured(
      "pi-cloud is not configured: set the secrets PI_CLOUD_API_KEYS, PI_CLOUD_RUNNER_SECRET and PI_CLOUD_CREDENTIAL_KEY (wrangler secret put), and check PI_CLOUD_CONFIG; details are in the Worker logs"
    )
  }
  return result.success
}
