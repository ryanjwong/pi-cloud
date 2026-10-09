import { WakeRequest } from "@pi-cloud/protocol"
import * as Cloudflare from "alchemy/Cloudflare"
import { WorkerRunnerEnv } from "@pi-cloud/config"
import { Effect, Redacted, Schema } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/http"
import SessionHost from "./SessionHost.ts"

/**
 * The runner host's front door: the control plane's HTTP dispatcher POSTs wake requests here, and each goes to
 * the session's own Durable Object. Point the control plane at it with `RunnerDispatcher.http({ url, secret })`.
 */
export default Cloudflare.Worker(
  "PiCloudRunners",
  {
    main: import.meta.url,
    compatibility: { flags: ["nodejs_compat"] }
  },
  Effect.gen(function*() {
    const hosts = yield* SessionHost
    // Loading the runner's config schema in init binds every key in it to this Worker (secrets as Worker
    // secrets), read from the deploy environment. Its Durable Objects share that environment.
    const env = yield* WorkerRunnerEnv
    const secret = env.runnerSecret
    const decode = Schema.decodeUnknownEffect(WakeRequest)

    return {
      fetch: Effect.gen(function*() {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.method !== "POST") return HttpServerResponse.text("Method not allowed", { status: 405 })
        if (request.headers["authorization"] !== `Bearer ${Redacted.value(secret)}`) {
          return HttpServerResponse.text("Unauthorized", { status: 401 })
        }
        const wake = yield* request.json.pipe(Effect.flatMap(decode), Effect.option)
        if (wake._tag === "None") return HttpServerResponse.text("Invalid wake request", { status: 400 })
        yield* hosts.getByName(wake.value.sessionId).wake(wake.value)
        return HttpServerResponse.empty({ status: 202 })
      })
    }
  })
)
