import { ControlPlaneEnv, modelCredentialLookup, RunnerEnv, sandboxSecretLookup } from "@pi-cloud/config"
import { isLoopback } from "@pi-cloud/control-plane"
import { connectors } from "@pi-cloud/connectors"
import { sqliteStores } from "@pi-cloud/storage-sqlite/node"
import { memoryReplica } from "@pi-cloud/runner/node"
import { Option, Redacted } from "effect"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { keyed, load } from "./env.ts"
import { randomSecret, startLocal } from "./index.ts"
import { defaultPlugins } from "./plugins.ts"

const control = await load(ControlPlaneEnv)
const runner = await load(RunnerEnv)
const dataDir = resolve(control.dataDir)
const hasKeys = keyed(control)

if (!isLoopback(control.host)) {
  const missing = [...(hasKeys ? [] : ["PI_CLOUD_API_KEYS"]), ...(control.credentialKeys.length === 0 ? ["PI_CLOUD_CREDENTIAL_KEY"] : [])]
  if (missing.length > 0) {
    console.error(`HOST=${control.host} is reachable from other machines: set ${missing.join(" and ")} (or listen on 127.0.0.1).`)
    process.exit(1)
  }
}

const generated = (name: string) => {
  const file = join(dataDir, name)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(file, `${randomSecret()}\n`, { mode: 0o600, flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  chmodSync(file, 0o600)
  return { file, value: readFileSync(file, "utf8").trim() }
}

const link = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi-cloud", "admin-token")
const adminToken = hasKeys ? undefined : generated("admin-token")
if (adminToken === undefined) {
  try {
    if (lstatSync(link).isSymbolicLink()) rmSync(link)
  } catch {}
} else {
  console.log(`Admin API key: ${adminToken.file}`)
  try {
    mkdirSync(dirname(link), { recursive: true, mode: 0o700 })
    rmSync(link, { force: true })
    symlinkSync(adminToken.file, link)
    console.log(`The pi-cloud CLI on this machine finds it through ${link}`)
  } catch {}
}
const keyFile = join(dataDir, "credential-key")

const deployment = await startLocal({
  port: control.port,
  host: control.host,
  settings: control.settings,
  auth: control.auth,
  apiKeys: control.apiKeys.map((key) => Redacted.value(key)),
  ...(adminToken === undefined ? {} : { apiKey: adminToken.value }),
  ...Option.match(control.runnerSecret, { onNone: () => ({}), onSome: (secret) => ({ runnerSecret: Redacted.value(secret) }) }),
  ...sqliteStores({
    file: join(dataDir, "pi-cloud.sqlite"),
    credentialKeys: control.credentialKeys.length === 0
      ? [generated("credential-key").value]
      : [...control.credentialKeys.map((key) => Redacted.value(key)), ...(existsSync(keyFile) ? [readFileSync(keyFile, "utf8").trim()] : [])]
  }),
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
