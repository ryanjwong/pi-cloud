// A runner host alone: accepts wake requests and attaches back to the control plane.
//   CONTROL_PLANE_URL=http://control.internal:8787 PORT=8788 node src/runner.ts
// Any machine, container, or platform that can run this and reach the control plane can host sessions.
import { RunnerHost } from "@pi-cloud/runner"
import { createServer } from "node:http"
import { resolve } from "node:path"
import { Readable } from "node:stream"
import { defaultPlugins } from "./plugins.ts"

const port = Number(process.env.PORT ?? 8788)
const host = new RunnerHost({
  plugins: defaultPlugins(resolve(process.env.DATA_DIR ?? ".data")),
  secret: process.env.PI_CLOUD_RUNNER_SECRET,
  controlPlaneUrl: process.env.CONTROL_PLANE_URL
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
}).listen(port, () => console.log(`pi-cloud runner host listening on :${port}`))
