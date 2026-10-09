// A runner host alone: accepts wake requests and attaches back to the control plane (CONTROL_PLANE_URL).
//   sops exec-env secrets.yaml 'node src/runner.ts'
// Any machine, container, or platform that can run this and reach the control plane can host sessions.
import { modelCredentialLookup, RunnerEnv, sandboxSecretLookup } from "@pi-cloud/config"
import { RunnerHost } from "@pi-cloud/runner"
import { Option, Redacted } from "effect"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { Readable } from "node:stream"
import { load } from "./env.ts"
import { defaultPlugins } from "./plugins.ts"

const env = await load(RunnerEnv)
const host = new RunnerHost({
  plugins: defaultPlugins(resolve(env.dataDir)),
  secret: Option.getOrUndefined(Option.map(env.runnerSecret, Redacted.value)),
  controlPlaneUrl: Option.getOrUndefined(env.controlPlaneUrl),
  modelCredentials: modelCredentialLookup(env),
  secrets: sandboxSecretLookup(env)
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
