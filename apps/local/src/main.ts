// All-in-one: control plane and runner in one process, state in SQLite under DATA_DIR.
//   sops exec-env secrets.yaml 'node src/main.ts'
import { ControlPlaneEnv, modelCredentialLookup, RunnerEnv, sandboxSecretLookup } from "@pi-cloud/config"
import { sqliteBindings, sqliteSessions, sqliteState } from "@pi-cloud/storage-sqlite"
import { Option, Redacted } from "effect"
import { join, resolve } from "node:path"
import { connectors } from "./connectors.ts"
import { load } from "./env.ts"
import { startLocal } from "./index.ts"
import { defaultPlugins } from "./plugins.ts"

const control = await load(ControlPlaneEnv)
const runner = await load(RunnerEnv)
const dataDir = resolve(control.dataDir)
const secret = (value: Option.Option<Redacted.Redacted<string>>) => Option.getOrUndefined(Option.map(value, Redacted.value))

const deployment = await startLocal({
  port: control.port,
  host: control.host,
  apiKeys: control.apiKeys.map((key) => Redacted.value(key)),
  runnerSecret: secret(control.runnerSecret),
  sessions: sqliteSessions({ file: join(dataDir, "sessions.sqlite") }),
  state: sqliteState({ directory: join(dataDir, "state") }),
  bindings: sqliteBindings({ file: join(dataDir, "sessions.sqlite") }),
  extensions: connectors(control),
  runner: {
    plugins: defaultPlugins(runner),
    modelCredentials: modelCredentialLookup(runner),
    secrets: sandboxSecretLookup(runner)
  }
})

console.log(`pi-cloud listening on ${deployment.url} (API docs at ${deployment.url}/docs, data in ${dataDir})`)
const shutdown = async () => {
  await deployment.stop()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
