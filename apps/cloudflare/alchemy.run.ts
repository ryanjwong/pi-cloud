// Deploy the Cloudflare runner host:
//   CONTROL_PLANE_URL=https://control.example.com PI_CLOUD_RUNNER_SECRET=... ANTHROPIC_API_KEY=... pnpm deploy
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
