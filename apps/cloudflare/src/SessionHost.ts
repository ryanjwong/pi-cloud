import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import type { WakeRequest } from "@pi-cloud/protocol"
import { modelProviders, RunnerHost } from "@pi-cloud/runner"
import * as Cloudflare from "alchemy/Cloudflare"
import { Config, Effect, Redacted } from "effect"

/** How often a busy host re-arms its alarm. Each alarm is an event, which keeps the object resident. */
const KEEPALIVE_MS = 20_000

/**
 * One Durable Object per session. It is only a place for a runner to live: it holds no state of its own (the
 * session's state lives in the control plane) and is reached only by wake requests. If Cloudflare evicts it
 * mid-run, the control plane sees the lease expire and wakes it again, and Pi resumes from its last checkpoint.
 */
export default class SessionHost extends Cloudflare.DurableObject<SessionHost>()(
  "SessionHost",
  Effect.gen(function*() {
    const state = yield* Cloudflare.DurableObjectState
    // Bound by the hosting Worker (see worker.ts); read here from the shared environment.
    const controlPlaneUrl = yield* Config.String("CONTROL_PLANE_URL").pipe(Effect.orDie)
    const secret = yield* Config.Redacted("PI_CLOUD_RUNNER_SECRET").pipe(Effect.orDie)

    return Effect.gen(function*() {
      const host = new RunnerHost({
        controlPlaneUrl,
        secret: Redacted.value(secret),
        // Model keys reach pi-ai through `process.env` (nodejs_compat_populate_process_env).
        plugins: [modelProviders(anthropicProvider, openaiProvider)]
      })
      const keepAlive = state.storage.setAlarm(Date.now() + KEEPALIVE_MS)

      return {
        wake: (request: WakeRequest) =>
          Effect.gen(function*() {
            yield* Effect.promise(() => host.wake(request))
            yield* keepAlive
          }),
        alarm: () => (host.hosted().length > 0 ? keepAlive : Effect.void)
      }
    })
  })
) {}
