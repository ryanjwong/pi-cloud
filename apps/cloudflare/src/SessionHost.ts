import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { modelCredentialLookup, WorkerRunnerEnv } from "@pi-cloud/config"
import type { WakeRequest } from "@pi-cloud/protocol"
import { modelProviders, RunnerHost } from "@pi-cloud/runner"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect, Redacted } from "effect"

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
    // The hosting Worker binds these (see worker.ts); the object reads them from the shared environment.
    const env = yield* WorkerRunnerEnv.pipe(Effect.orDie)

    return Effect.gen(function*() {
      const host = new RunnerHost({
        controlPlaneUrl: env.controlPlaneUrl,
        secret: Redacted.value(env.runnerSecret),
        modelCredentials: modelCredentialLookup(env),
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
