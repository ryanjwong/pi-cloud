import { ControlPlaneEnv, modelCredentialLookup, RunnerEnv, sandboxSecretLookup } from "@pi-cloud/config"
import { sqliteStores } from "@pi-cloud/storage-sqlite/node"
import { Option, Redacted } from "effect"
import { join, resolve } from "node:path"
import { connectors } from "@pi-cloud/connectors"
import { memoryReplica } from "@pi-cloud/runner/node"
import { load } from "./env.ts"
import { isLoopback, startLocal } from "./index.ts"
import { defaultPlugins } from "./plugins.ts"

const control = await load(ControlPlaneEnv)
const runner = await load(RunnerEnv)
const dataDir = resolve(control.dataDir)
const secret = (value: Option.Option<Redacted.Redacted<string>>) => Option.getOrUndefined(Option.map(value, Redacted.value))

if (!isLoopback(control.host)) {
  const missing = [
    ...(control.apiKeys.length === 0 ? ["PI_CLOUD_API_KEYS"] : []),
    ...(Option.isNone(control.credentialKey) ? ["PI_CLOUD_CREDENTIAL_KEY"] : [])
  ]
  if (missing.length > 0) {
    console.error(`HOST=${control.host} is reachable from other machines: set ${missing.join(" and ")} (or listen on 127.0.0.1).`)
    process.exit(1)
  }
}

const deployment = await startLocal({
  port: control.port,
  host: control.host,
  settings: control.settings,
  apiKeys: control.apiKeys.map((key) => Redacted.value(key)),
  runnerSecret: secret(control.runnerSecret),
  ...sqliteStores({ file: join(dataDir, "pi-cloud.sqlite"), credentialKey: secret(control.credentialKey) }),
  ...connectors(control),
  runner: {
    plugins: defaultPlugins(runner),
    modelCredentials: modelCredentialLookup(runner),
    secrets: sandboxSecretLookup(runner),
    replica: memoryReplica
  }
})

console.log(`pi-cloud listening on ${deployment.url} (API docs at ${deployment.url}/docs, data in ${dataDir})`)
const shutdown = async () => {
  await deployment.stop()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
