import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node"
import { registerEnvConformance } from "@earendil-works/pi-durable/testing"
import type { WorkspaceCall, WorkspaceEvent } from "@pi-cloud/protocol"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { remoteEnv, serveWorkspace, type WorkspaceTransport } from "../src/index.ts"

/** A transport that behaves like the real one: JSON both ways, cancellation on abort. */
const loopback = (server: ReturnType<typeof serveWorkspace>): WorkspaceTransport => (call, onEvent, signal) =>
  new Promise((resolve, reject) => {
    const id = crypto.randomUUID()
    const wire = JSON.parse(JSON.stringify(call)) as WorkspaceCall
    const onAbort = () => {
      server.cancel(id)
      reject(new Error("aborted"))
    }
    if (signal?.aborted) return onAbort()
    signal?.addEventListener("abort", onAbort, { once: true })
    server.call(id, wire, (event) => {
      const received = JSON.parse(JSON.stringify(event)) as WorkspaceEvent
      if (received._tag === "End") {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      } else onEvent(received)
    })
  })

registerEnvConformance({ describe, expect, it }, "workspace env over JSON", async (use) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-cloud-workspace-"))
  const server = serveWorkspace(new NodeExecutionEnv({ cwd: dir }))
  try {
    await use(remoteEnv(loopback(server), { cwd: dir }))
  } finally {
    await server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
