import { NodeRuntime } from "@effect/platform-node"
import { ControlPlaneEnv } from "@pi-cloud/config"
import { pullDispatcher } from "@pi-cloud/control-plane"
import { serve } from "@pi-cloud/control-plane/node"
import { sqliteStores } from "@pi-cloud/storage-sqlite/node"
import { Layer, Option, Redacted } from "effect"
import { join, resolve } from "node:path"
import { connectors } from "@pi-cloud/connectors"
import { keyed, load } from "./env.ts"

const env = await load(ControlPlaneEnv)
const missing = [
  ...(keyed(env) ? [] : ["PI_CLOUD_API_KEYS"]),
  ...(Option.isNone(env.runnerSecret) ? ["PI_CLOUD_RUNNER_SECRET"] : []),
  ...(env.credentialKeys.length === 0 ? ["PI_CLOUD_CREDENTIAL_KEY"] : [])
]
if (missing.length > 0) {
  console.error(`Set ${missing.join(", ")} to run the control plane on its own.`)
  process.exit(1)
}
const dataDir = resolve(env.dataDir)

Layer.launch(serve({
  port: env.port,
  host: env.host,
  settings: { ...env.settings, publicUrl: Option.getOrElse(env.publicUrl, () => `http://${env.host}:${env.port}`) },
  auth: env.auth,
  apiKeys: env.apiKeys.map((key) => Redacted.value(key)),
  runnerSecret: Redacted.value(Option.getOrThrow(env.runnerSecret)),
  ...sqliteStores({ file: join(dataDir, "pi-cloud.sqlite"), credentialKeys: env.credentialKeys.map((key) => Redacted.value(key)) }),
  ...connectors(env),
  dispatcher: pullDispatcher
})).pipe(NodeRuntime.runMain)
