// Deploy the Cloudflare runner host:
//   sops exec-env ../../secrets.yaml 'pnpm run deploy'   (needs CONTROL_PLANE_URL, PI_CLOUD_RUNNER_SECRET, model keys)
// Then start the control plane with RUNNER_URL=<printed url> and the same PI_CLOUD_RUNNER_SECRET.
import * as Alchemy from "alchemy"
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"
import Runners from "./src/worker.ts"

export default Alchemy.Stack(
  "pi-cloud",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function*() {
    const runners = yield* Runners
    return { runnerUrl: runners.url }
  })
)
