import { modelCredentialLookup, RunnerEnv, sandboxSecretLookup } from "@pi-cloud/config"
import { RunnerHost } from "@pi-cloud/runner"
import { memoryReplica } from "@pi-cloud/runner/node"
import { Option, Redacted } from "effect"
import { createServer } from "node:http"
import { Readable } from "node:stream"
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

createServer(async (req, res) => {
  const response = await host.handler(new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers as Record<string, string>,
    body: req.method === "POST" ? (Readable.toWeb(req) as ReadableStream) : undefined,
    duplex: "half"
  } as RequestInit))
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(await response.text())
}).listen(env.port, env.host, () => console.log(`pi-cloud runner host listening on ${env.host}:${env.port}`))
