import type { Context, Facet } from "@earendil-works/chord"
import type { Principal } from "@pi-cloud/protocol"
import type { Provider } from "@earendil-works/pi-ai"
import type { MutableModels } from "@earendil-works/pi-ai/models"
import type {
  Conversation,
  EnvTarget,
  Extension,
  Harness,
  HarnessSettings
} from "@earendil-works/pi-durable"
import type { ExecutionEnv } from "@earendil-works/pi-durable/env"
import type { Session } from "@pi-cloud/protocol"
import { Effect } from "effect"

export type SecretResolver = (name: string) => Promise<string | undefined>

export const noSecrets: SecretResolver = async () => undefined

export const envSecrets: SecretResolver = async (name) => globalThis.process?.env?.[name]

export interface PluginContext {
  readonly session: Session
  readonly secrets: SecretResolver
}

export type EnvResolver = (
  target: EnvTarget,
  context: Context
) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>

export type CommandHandler = (payload: unknown, api: RunningSession, context: Context) => Promise<unknown>

export interface RunningSession {
  readonly session: Session
  readonly harness: Harness
  readonly root: Conversation
}

export interface PluginParts {
  readonly extensions?: ReadonlyArray<Extension>
  readonly models?: (models: MutableModels) => void
  readonly env?: EnvResolver
  readonly settings?: HarnessSettings
  readonly commands?: Readonly<Record<string, CommandHandler>>
  readonly facets?: ReadonlyArray<Facet<Principal>>
  readonly ready?: (api: RunningSession, context: Context) => void | Promise<void>
  readonly dispose?: () => void | Promise<void>
}

export interface RunnerPlugin {
  readonly name: string
  readonly setup: (
    context: PluginContext
  ) => PluginParts | Promise<PluginParts> | Effect.Effect<PluginParts, unknown>
}

export const definePlugin = (plugin: RunnerPlugin): RunnerPlugin => plugin

export const runSetup = (plugin: RunnerPlugin, context: PluginContext): Promise<PluginParts> => {
  const result = plugin.setup(context)
  return Effect.isEffect(result) ? Effect.runPromise(result) : Promise.resolve(result)
}

export const modelProviders = (...providers: ReadonlyArray<Provider | (() => Provider)>): RunnerPlugin =>
  definePlugin({
    name: "model-providers",
    setup: () => ({
      models: (models) => {
        for (const provider of providers) models.setProvider(typeof provider === "function" ? provider() : provider)
      }
    })
  })

export const extensions = (name: string, ...installed: ReadonlyArray<Extension>): RunnerPlugin =>
  definePlugin({ name, setup: () => ({ extensions: installed }) })
