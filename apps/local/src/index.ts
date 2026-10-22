import { type ControlPlaneOptions, ControlPlane } from "@pi-cloud/control-plane"
import { bound, nodeServer } from "@pi-cloud/control-plane/node"
import { RunnerDispatcher } from "@pi-cloud/core"
import { RunnerHost, type RunnerHostOptions } from "@pi-cloud/runner"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { randomBytes } from "node:crypto"

export const randomSecret = () => randomBytes(32).toString("base64url")

export interface LocalOptions extends Omit<ControlPlaneOptions, "dispatcher" | "settings" | "runnerSecret"> {
  readonly port: number
  readonly host?: string
  readonly apiKey?: string
  readonly runnerSecret?: string
  readonly dispatcher?: ControlPlaneOptions["dispatcher"]
  readonly settings?: Partial<ControlPlaneOptions["settings"]>
  readonly runner: Omit<RunnerHostOptions, "secret" | "controlPlaneUrl">
}

export interface LocalDeployment {
  readonly url: string
  readonly apiKey: string
  readonly runnerSecret: string
  readonly runners: RunnerHost
  stop(): Promise<void>
}

export const startLocal = async (options: LocalOptions): Promise<LocalDeployment> => {
  const host = options.host ?? "127.0.0.1"
  const url = `http://${host}:${options.port}`
  const apiKey = options.apiKey ?? randomSecret()
  const runnerSecret = options.runnerSecret ?? randomSecret()
  const runners = new RunnerHost({ ...options.runner, secret: runnerSecret, controlPlaneUrl: url })
  const server = HttpRouter.serve(ControlPlane.layer(bound({
    ...options,
    apiKeys: [...options.apiKeys ?? [], apiKey],
    runnerSecret,
    settings: { ...options.settings, publicUrl: options.settings?.publicUrl ?? url },
    dispatcher: options.dispatcher ?? RunnerDispatcher.make((request) => runners.wake(request))
  }, host)), { disableLogger: true }).pipe(Layer.provide(nodeServer(options.port, host)))
  const fiber = Effect.runFork(Layer.launch(server))
  for (let attempt = 0; ; attempt++) {
    const ready = await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }).then((response) => response.ok, () => false)
    if (ready) break
    const exit = fiber.pollUnsafe()
    if (exit !== undefined && Exit.isFailure(exit)) throw Cause.squash(exit.cause)
    if (attempt > 100) throw new Error(`Control plane did not start on ${url}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return {
    url,
    apiKey,
    runnerSecret,
    runners,
    stop: async () => {
      await runners.close()
      await Effect.runPromise(Fiber.interrupt(fiber))
    }
  }
}
