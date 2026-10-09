import { NodeHttpServer } from "@effect/platform-node"
import { type ControlPlaneOptions, ControlPlane, RunnerDispatcher } from "@pi-cloud/control-plane"
import { RunnerHost, type RunnerHostOptions } from "@pi-cloud/runner"
import { Effect, Fiber, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { createServer } from "node:http"

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
  const runners = new RunnerHost({ ...options.runner, secret: options.runnerSecret, controlPlaneUrl: url })
  const server = HttpRouter.serve(ControlPlane.layer({
    ...options,
    settings: { ...options.settings, publicUrl: options.settings?.publicUrl ?? url },
    dispatcher: RunnerDispatcher.make((request) => runners.wake(request))
  }), { disableLogger: true }).pipe(
    Layer.provide(NodeHttpServer.layer(createServer, { port: options.port, host: options.host ?? "127.0.0.1" }))
  )
  const fiber = Effect.runFork(Layer.launch(server))
  for (let attempt = 0; ; attempt++) {
    const ready = await fetch(`${url}/health`).then((response) => response.ok, () => false)
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
