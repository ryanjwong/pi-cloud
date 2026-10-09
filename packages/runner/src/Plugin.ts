import type { Context } from "@earendil-works/chord"
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
import type { Session, WorkspaceCall, WorkspaceEvent } from "@pi-cloud/protocol"
import { Effect } from "effect"

/** Resolves secret names (from a session's spec) to values, on the runner. */
export type SecretResolver = (name: string) => Promise<string | undefined>

/** The default: no secrets at all. A runner only hands out secrets it is explicitly given. */
export const noSecrets: SecretResolver = async () => undefined

/** Reads secrets from the runner's environment variables. Anything in that environment becomes requestable. */
export const envSecrets: SecretResolver = async (name) => globalThis.process?.env?.[name]

/** What a plugin sees when a runner starts hosting a session. */
export interface PluginContext {
  readonly session: Session
  /** This plugin's entry in the session spec's `plugins`, if any. */
  readonly config: unknown
  readonly secrets: SecretResolver
  /**
   * Sends one call to the client serving this session's workspace (see `spec.workspace`), through the control
   * plane, reporting its events until it ends. Rejects when no client serves it in time.
   */
  readonly workspace: (
    call: WorkspaceCall,
    onEvent: (event: WorkspaceEvent) => void,
    signal: AbortSignal | undefined
  ) => Promise<void>
}

/** Builds a conversation's execution environment; return `undefined` to let the next plugin decide. */
export type EnvResolver = (
  target: EnvTarget,
  context: Context
) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>

/** Handles a `Custom` command sent through the control plane. */
export type CommandHandler = (payload: unknown, api: RunningSession, context: Context) => Promise<unknown>

/** The hosted session, for plugins that act after startup. */
export interface RunningSession {
  readonly session: Session
  readonly harness: Harness
  readonly root: Conversation
}

/** What a plugin contributes to one hosted session. Every field is optional; contributions compose. */
export interface PluginParts {
  /** Pi extensions: tools, prompt sections, hooks, tasks, documents. */
  readonly extensions?: ReadonlyArray<Extension>
  /** Register model providers. */
  readonly models?: (models: MutableModels) => void
  /** Execution environments for tools; the first plugin returning one wins. */
  readonly env?: EnvResolver
  /** Pi harness settings, merged shallowly in plugin order. */
  readonly settings?: HarnessSettings
  /** Named custom commands. */
  readonly commands?: Readonly<Record<string, CommandHandler>>
  /** Runs once the harness is open and the root conversation exists. */
  readonly ready?: (api: RunningSession, context: Context) => void | Promise<void>
  /** Runs when the runner stops hosting the session. */
  readonly dispose?: () => void | Promise<void>
}

/**
 * A runner plugin: called once for each session a runner hosts, so it can tailor what it contributes to that
 * session's spec. `setup` may return parts directly, a promise, or an Effect.
 */
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

/** A plugin that only registers pi-ai model providers. */
export const modelProviders = (...providers: ReadonlyArray<Provider | (() => Provider)>): RunnerPlugin =>
  definePlugin({
    name: "model-providers",
    setup: () => ({
      models: (models) => {
        for (const provider of providers) models.setProvider(typeof provider === "function" ? provider() : provider)
      }
    })
  })

/** A plugin that only installs Pi extensions. */
export const extensions = (name: string, ...installed: ReadonlyArray<Extension>): RunnerPlugin =>
  definePlugin({ name, setup: () => ({ extensions: installed }) })
