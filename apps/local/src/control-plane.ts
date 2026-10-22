import { NodeRuntime } from "@effect/platform-node"
import { ControlPlaneEnv } from "@pi-cloud/config"
import { serve } from "@pi-cloud/control-plane/node"
import { RunnerDispatcher } from "@pi-cloud/core"
import { sqliteStores } from "@pi-cloud/storage-sqlite/node"
import { Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { join, resolve } from "node:path"
import { connectors, sessionSecrets } from "./connectors.ts"
import { load } from "./env.ts"

const env = await load(ControlPlaneEnv)
const missing = [
  ...(Option.isNone(env.runnerUrl) ? ["RUNNER_URL"] : []),
  ...(env.apiKeys.length === 0 ? ["PI_CLOUD_API_KEYS"] : []),
  ...(Option.isNone(env.runnerSecret) ? ["PI_CLOUD_RUNNER_SECRET"] : []),
  ...(Option.isNone(env.credentialKey) ? ["PI_CLOUD_CREDENTIAL_KEY"] : [])
]
if (missing.length > 0) {
  console.error(`Set ${missing.join(", ")} to run the control plane on its own.`)
  process.exit(1)
}
const runnerUrl = Option.getOrThrow(env.runnerUrl)
const runnerSecret = Redacted.value(Option.getOrThrow(env.runnerSecret))
const dataDir = resolve(env.dataDir)

Layer.launch(serve({
  port: env.port,
  host: env.host,
  settings: { ...env.settings, publicUrl: Option.getOrElse(env.publicUrl, () => `http://${env.host}:${env.port}`) },
  apiKeys: env.apiKeys.map((key) => Redacted.value(key)),
  runnerSecret,
  ...sqliteStores({ file: join(dataDir, "pi-cloud.sqlite"), credentialKey: Option.getOrUndefined(Option.map(env.credentialKey, Redacted.value)) }),
  extensions: connectors(env),
  sessionSecrets: sessionSecrets(env),
  dispatcher: RunnerDispatcher.http({ url: runnerUrl, secret: runnerSecret }).pipe(Layer.provide(FetchHttpClient.layer))
})).pipe(NodeRuntime.runMain)
