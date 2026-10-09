// pi-cloud-config: which settings and secrets are set, and where from. Never prints values.
//   sops exec-env secrets.yaml 'node src/config.ts'
import { NodeServices } from "@effect/platform-node"
import { ConfigSource } from "@pi-cloud/config"
import { Effect } from "effect"

const rows = await Effect.runPromise(ConfigSource.status.pipe(Effect.provide(NodeServices.layer)))
const directory = ConfigSource.secretsDirectory()
console.log(`secrets directory: ${directory ?? "(none: set PI_CLOUD_SECRETS_DIR or run under systemd LoadCredential)"}\n`)
const width = Math.max(...rows.map((row) => row.name.length))
for (const row of rows) {
  const state = row.source === undefined ? (row.default === undefined ? "unset" : `default ${row.default}`) : `set (${row.source})`
  const kind = row.secret ? "secret " : "setting"
  console.log(`${row.name.padEnd(width)}  ${kind}  ${state.padEnd(32)}  ${row.components.join(", ").padEnd(22)}  ${row.description}`)
}
