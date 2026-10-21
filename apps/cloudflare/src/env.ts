import type { DurableObjectNamespace } from "@cloudflare/workers-types"
import { CloudflareEnv } from "@pi-cloud/config"
import { ConfigProvider, Effect } from "effect"
import type { ControlPlane } from "./ControlPlane.ts"
import type { SessionHost } from "./SessionHost.ts"

/** The Worker's bindings: the two Durable Object classes, and settings and secrets (`wrangler secret put`). */
export interface Env {
  readonly CONTROL_PLANE: DurableObjectNamespace<ControlPlane>
  readonly SESSION_HOST: DurableObjectNamespace<SessionHost>
  readonly [setting: string]: unknown
}

/** The one control plane object. */
export const CONTROL_PLANE = "control-plane"

/**
 * The URL runners are told to reach the control plane at. They never resolve it: their requests go to the control
 * plane object's stub.
 */
export const INTERNAL_URL = "https://control-plane.internal"

/** Settings the deployment cannot run without; the message names what to set. */
export class NotConfigured extends Error {}

/** The deployment's settings, from the Worker's string bindings. */
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
    throw new NotConfigured(
      "pi-cloud is not configured: set the secrets PI_CLOUD_API_KEYS, PI_CLOUD_RUNNER_SECRET and PI_CLOUD_CREDENTIAL_KEY (wrangler secret put)"
    )
  }
  return result.success
}
