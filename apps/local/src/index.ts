import type { ControlPlaneOptions } from "@pi-cloud/control-plane"
import { listen } from "@pi-cloud/control-plane/node"
import { RunnerDispatcher } from "@pi-cloud/core"
import { RunnerHost, type RunnerHostOptions } from "@pi-cloud/runner"
import { randomBytes } from "node:crypto"

export const randomSecret = () => randomBytes(32).toString("base64url")

export interface LocalOptions extends Omit<ControlPlaneOptions, "dispatcher" | "settings" | "runnerSecret"> {
  readonly port?: number
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
  const server = await listen(options.port ?? 0, host)
  const { url } = server
  const apiKey = options.apiKey ?? randomSecret()
  const runnerSecret = options.runnerSecret ?? randomSecret()
  const runners = new RunnerHost({ ...options.runner, secret: runnerSecret, controlPlaneUrl: url })
  await server.serve({
    ...options,
    apiKeys: [...options.apiKeys ?? [], apiKey],
    runnerSecret,
    settings: { ...options.settings, publicUrl: options.settings?.publicUrl ?? url },
    dispatcher: options.dispatcher ?? RunnerDispatcher.make((request) => runners.wake(request))
  }, { disableLogger: true })
  return {
    url,
    apiKey,
    runnerSecret,
    runners,
    stop: async () => {
      await runners.close()
      await server.close()
    }
  }
}
