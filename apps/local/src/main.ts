// All-in-one: control plane and runner in one process, state in SQLite under DATA_DIR.
//   node src/main.ts
import { sqliteSessions, sqliteState } from "@pi-cloud/storage-sqlite"
import { join, resolve } from "node:path"
import { startLocal } from "./index.ts"
import { defaultPlugins } from "./plugins.ts"

const port = Number(process.env.PORT ?? 8787)
const dataDir = resolve(process.env.DATA_DIR ?? ".data")
const apiKeys = process.env.PI_CLOUD_API_KEYS?.split(",").filter(Boolean)

const deployment = await startLocal({
  port,
  host: process.env.HOST ?? "127.0.0.1",
  apiKeys,
  runnerSecret: process.env.PI_CLOUD_RUNNER_SECRET,
  sessions: sqliteSessions({ file: join(dataDir, "sessions.sqlite") }),
  state: sqliteState({ directory: join(dataDir, "state") }),
  runner: { plugins: defaultPlugins(dataDir) }
})

console.log(`pi-cloud listening on ${deployment.url} (API docs at ${deployment.url}/docs, data in ${dataDir})`)
const shutdown = async () => {
  await deployment.stop()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
