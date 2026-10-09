// The control plane alone. Runners live elsewhere and are woken over HTTP:
//   RUNNER_URL=http://runners.internal:8788/wake PUBLIC_URL=http://control.internal:8787 node src/control-plane.ts
import { NodeRuntime } from "@effect/platform-node"
import { RunnerDispatcher } from "@pi-cloud/core"
import { serve } from "@pi-cloud/control-plane/node"
import { sqliteSessions, sqliteState } from "@pi-cloud/storage-sqlite"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"
import { join, resolve } from "node:path"

const port = Number(process.env.PORT ?? 8787)
const dataDir = resolve(process.env.DATA_DIR ?? ".data")
const runnerUrl = process.env.RUNNER_URL
if (runnerUrl === undefined) throw new Error("Set RUNNER_URL to the runner host's wake endpoint")
const runnerSecret = process.env.PI_CLOUD_RUNNER_SECRET

Layer.launch(serve({
  port,
  host: process.env.HOST ?? "0.0.0.0",
  settings: { publicUrl: process.env.PUBLIC_URL ?? `http://127.0.0.1:${port}` },
  apiKeys: process.env.PI_CLOUD_API_KEYS?.split(",").filter(Boolean),
  runnerSecret,
  sessions: sqliteSessions({ file: join(dataDir, "sessions.sqlite") }),
  state: sqliteState({ directory: join(dataDir, "state") }),
  dispatcher: RunnerDispatcher.http({ url: runnerUrl, secret: runnerSecret }).pipe(Layer.provide(FetchHttpClient.layer))
})).pipe(NodeRuntime.runMain)
