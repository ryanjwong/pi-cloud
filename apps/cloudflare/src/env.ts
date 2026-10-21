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

/** The deployment's settings, from the Worker's string bindings. */
export const settings = (env: Env): Promise<CloudflareEnv> =>
  Effect.runPromise(
    Effect.gen(function*() {
      return yield* CloudflareEnv
    }).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(
        Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      ))),
      Effect.orDie
    )
  )
