import { NodeHttpServer } from "@effect/platform-node"
import { type ControlPlaneOptions, ControlPlane } from "@pi-cloud/control-plane"
import { RunnerDispatcher } from "@pi-cloud/core"
import { RunnerHost, type RunnerHostOptions } from "@pi-cloud/runner"
import { Effect, Fiber, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { randomBytes } from "node:crypto"
import { createServer } from "node:http"

const randomSecret = () => randomBytes(32).toString("base64url")

export const isLoopback = (host: string) => ["127.0.0.1", "::1", "localhost"].includes(host) || host.startsWith("127.")

export interface LocalOptions extends Omit<ControlPlaneOptions, "dispatcher" | "settings"> {
  readonly port: number
  readonly host?: string
  readonly settings?: Partial<ControlPlaneOptions["settings"]>
  readonly runner: Omit<RunnerHostOptions, "secret" | "controlPlaneUrl">
}

export interface LocalDeployment {
  readonly url: string
  readonly runners: RunnerHost
  stop(): Promise<void>
}

export const startLocal = async (options: LocalOptions): Promise<LocalDeployment> => {
  const url = `http://${options.host ?? "127.0.0.1"}:${options.port}`
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
