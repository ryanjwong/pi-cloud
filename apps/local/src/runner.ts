import { modelCredentialLookup, RunnerEnv, sandboxSecretLookup } from "@pi-cloud/config"
import { RunnerHost } from "@pi-cloud/runner"
import { memoryReplica } from "@pi-cloud/runner/node"
import { Option, Redacted } from "effect"
import { load } from "./env.ts"
import { defaultPlugins } from "./plugins.ts"

const env = await load(RunnerEnv)
if (Option.isNone(env.runnerSecret) || Option.isNone(env.controlPlaneUrl)) {
  console.error("Set PI_CLOUD_RUNNER_SECRET and CONTROL_PLANE_URL to run a runner host.")
  process.exit(1)
}
const host = new RunnerHost({
  plugins: defaultPlugins(env),
  secret: Redacted.value(env.runnerSecret.value),
  controlPlaneUrl: env.controlPlaneUrl.value,
  modelCredentials: modelCredentialLookup(env),
  secrets: sandboxSecretLookup(env),
  replica: memoryReplica
})
host.connect()
console.log(`pi-cloud runner host pulling wake requests from ${env.controlPlaneUrl.value}`)
const shutdown = async () => {
  await host.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
