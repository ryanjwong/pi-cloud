import { NodeHttpServer } from "@effect/platform-node"
import { type ControlPlaneOptions, ControlPlane } from "@pi-cloud/control-plane"
import { RunnerDispatcher } from "@pi-cloud/core"
import { RunnerHost, type RunnerHostOptions } from "@pi-cloud/runner"
import { Effect, Fiber, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"

const randomSecret = () => randomBytes(32).toString("base64url")

/** Whether `host` only accepts connections from this machine. */
export const isLoopback = (host: string) => ["127.0.0.1", "::1", "localhost"].includes(host) || host.startsWith("127.")

export interface LocalOptions extends Omit<ControlPlaneOptions, "dispatcher" | "settings"> {
  readonly port: number
  readonly host?: string
  readonly settings?: Partial<ControlPlaneOptions["settings"]>
  readonly runner: Omit<RunnerHostOptions, "secret" | "controlPlaneUrl">
}

export interface LocalDeployment {
  readonly url: string
  /** The in-process runner host. */
  readonly runners: RunnerHost
  stop(): Promise<void>
}

/**
 * Start a control plane and an in-process runner host. They still talk over HTTP, exactly as they would on
 * separate machines; only the dispatcher is local (it calls `RunnerHost.wake` directly).
 */
export const startLocal = async (options: LocalOptions): Promise<LocalDeployment> => {
  const url = `http://${options.host ?? "127.0.0.1"}:${options.port}`
  // The runner channel always needs a secret: without one, anyone who reaches the port could attach as a runner and
  // read every session's state. Both halves live in this process, so a random one per start is enough.
  const runnerSecret = options.runnerSecret ?? randomSecret()
  const runners = new RunnerHost({ ...options.runner, secret: runnerSecret, controlPlaneUrl: url })
  const server = HttpRouter.serve(ControlPlane.layer({
    ...options,
    runnerSecret,
    settings: { ...options.settings, publicUrl: options.settings?.publicUrl ?? url },
    dispatcher: RunnerDispatcher.make((request) => runners.wake(request))
  }), { disableLogger: true }).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port: options.port, host: options.host ?? "127.0.0.1" }))
  )
  const fiber = Effect.runFork(Layer.launch(server))
  for (let attempt = 0; ; attempt++) {
    // A request that arrives while the routes are still being built may never be answered: probe with a timeout.
    const ready = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }).then((response) => response.ok, () => false)
    if (ready) break
    if (attempt > 100) throw new Error(`Control plane did not start on ${url}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return {
    url,
    runners,
    stop: async () => {
      await runners.close()
      await Effect.runPromise(Fiber.interrupt(fiber))
    }
  }
}
