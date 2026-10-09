// The control plane alone. Runners live elsewhere and are woken over HTTP (RUNNER_URL):
//   sops exec-env secrets.yaml 'node src/control-plane.ts'
import { NodeRuntime } from "@effect/platform-node"
import { ControlPlaneEnv } from "@pi-cloud/config"
import { serve } from "@pi-cloud/control-plane/node"
import { RunnerDispatcher } from "@pi-cloud/core"
import { sqliteBindings, sqliteSessions, sqliteState } from "@pi-cloud/storage-sqlite"
import { Layer, Option, Redacted } from "effect"
import { FetchHttpClient } from "effect/http"
import { join, resolve } from "node:path"
import { connectors } from "./connectors.ts"
import { load } from "./env.ts"

const env = await load(ControlPlaneEnv)
const runnerUrl = Option.getOrThrowWith(env.runnerUrl, () => new Error("Set RUNNER_URL to the runner host's wake endpoint"))
const runnerSecret = Option.getOrUndefined(Option.map(env.runnerSecret, Redacted.value))
const dataDir = resolve(env.dataDir)

Layer.launch(serve({
  port: env.port,
  host: env.host,
  settings: { publicUrl: Option.getOrElse(env.publicUrl, () => `http://${env.host}:${env.port}`) },
  apiKeys: env.apiKeys.map((key) => Redacted.value(key)),
  runnerSecret,
  sessions: sqliteSessions({ file: join(dataDir, "sessions.sqlite") }),
  state: sqliteState({ directory: join(dataDir, "state") }),
  bindings: sqliteBindings({ file: join(dataDir, "sessions.sqlite") }),
  extensions: connectors(env),
  dispatcher: RunnerDispatcher.http({ url: runnerUrl, secret: runnerSecret }).pipe(Layer.provide(FetchHttpClient.layer))
})).pipe(NodeRuntime.runMain)
